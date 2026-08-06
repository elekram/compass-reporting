// import { stringify } from '@std/csv'
import {
  AttendancePeriodLine,
  AttendanceStatus,
  ChronicleEntry,
  FormGroup,
  PeriodAttendanceLine,
  StudentBasic,
} from './compass-api.types.ts'
import { log } from '../logger.ts'

// claude: every Compass endpoint wraps its payload in a top-level "d". These three
// claude: envelope shapes were confirmed against the live API (see compass-query.ts
// claude: for ad-hoc spot-checks). Kept local to this file since they're a
// claude: fetch-layer concern, not a domain type.
interface CompassApiResponseEnvelope<T> {
  d: {
    __type: string
    data: T[]
    errorMessage: string | null
    success: boolean
    total: number
  }
}

interface CompassCursorApiResponseEnvelope<T> {
  d: {
    __type: string
    cursor: string | null
    data: T[]
    errorMessage: string | null
    success: boolean
  }
}

interface CompassFlatArrayEnvelope<T> {
  d: T[]
}

export function getSchoolUrl() {
  return 'cheltsec-vic.compass.education'
}

// claude: plain fetch() hangs indefinitely on a dropped connection with no error and
// claude: no way to recover — seen in practice mid-sync. Timeout + a few retries turns
// claude: that into a bounded failure instead.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
  timeoutMs = 60000,
): Promise<Response> {
  for (let attempt = 0;; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if (attempt >= retries) {
        throw error
      }
      const backoffMs = 1000 * 2 ** attempt
      log(
        `fetchWithRetry: attempt ${attempt + 1} failed (${
          error instanceof Error ? error.message : error
        }), retrying in ${backoffMs}ms`,
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }
}

// claude: a bad/expired API key, Compass maintenance, or a rate limit used to fail
// claude: deep inside JSON.parse or a ".map on undefined" a step later — useless in a
// claude: failure-alert email (see sync.ts's summary email). This surfaces the actual
// claude: HTTP status/body from the endpoint that failed instead.
async function textOrThrow(response: Response, endpoint: string): Promise<string> {
  const data = await response.text()
  if (!response.ok) {
    throw new Error(
      `Compass API request to ${endpoint} failed: ${response.status} ${response.statusText} — ${
        data.slice(0, 500)
      }`,
    )
  }
  return data
}

export function getHeaders() {
  const h = new Headers()
  const key = Deno.env.get('COMPASS_API_KEY')
  if (!key) {
    throw new Error('COMPASS_API_KEY is not set in deno.env')
  }

  h.append('Content-Type', 'application/json')
  h.append('CompassApiKey', key)

  return h
}

export async function attendanceGetPeriodLines(): Promise<
  Array<AttendancePeriodLine>
> {
  const endpoint = '/API/V4/Attendance/GetPeriodLines'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {
          'request': {
            'lBound': '2023-01-01T05:46:30Z',
            'uBound': '2023-06-01T05:46:30Z',
            'modifiedSinceTimestamp': '2023-08-01T05:46:30Z',
            'skip': 0,
            'take': 50,
          },
        },
      ),
    },
  )

  const data = await response.text()
  log(`attendanceGetPeriodLines: ${endpoint} responded ${response.status}`)
  return JSON.parse(data)
}

export async function attendanceGetStatuses(): Promise<
  Array<AttendanceStatus>
> {
  const endpoint = '/api/attendance/v3/GetStatuses'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {},
      ),
    },
  )

  const data = await textOrThrow(response, endpoint)
  const parsed: CompassFlatArrayEnvelope<AttendanceStatus> = JSON.parse(data)
  if (!Array.isArray(parsed.d)) {
    throw new Error(
      `Compass API ${endpoint} returned an unexpected shape (expected an array in "d"): ${
        data.slice(0, 500)
      }`,
    )
  }
  log(
    `attendanceGetStatuses: ${endpoint} responded ${response.status}, ${parsed.d.length} statuses`,
  )
  return parsed.d
}

export async function attendanceGetPeriodLinesBetweenBounds(
  start: string,
  end: string,
  modifiedSinceTimestamp: string = '2023-08-01T05:46:30Z',
  onPage?: (page: PeriodAttendanceLine[]) => Promise<void> | void,
  startSkip = 0,
): Promise<
  Array<PeriodAttendanceLine>
> {
  const endpoint = '/API/V4/Attendance/GetPeriodLinesTracking'
  const take = 1000
  // claude: only accumulated when there's no onPage callback — sync.ts's production
  // claude: callers pass onPage and persist each page straight to Postgres, never
  // claude: touching the return value, so holding the entire result (a full first-sync
  // claude: backfill can be 500k+ rows) in memory on top of that would be pure waste.
  // claude: compass-query.ts's ad-hoc CLI is the only caller that wants the array back,
  // claude: and it never passes onPage.
  const lines: PeriodAttendanceLine[] = []
  let skip = startSkip
  let total = Infinity

  // claude: skip/take pagination, not cursor-based — the envelope reports "total"
  // claude: so we page until skip catches up to it. Seen as 171612 for a 2-month
  // claude: window in testing, so a full year could mean ~1000 sequential requests;
  // claude: worth checking response time in practice before scheduling this unattended.
  while (skip < total) {
    const response = await fetchWithRetry(
      `https://${getSchoolUrl()}${endpoint}`,
      {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(
          {
            'request': {
              'lBound': `${start}T00:00:00Z`,
              'uBound': `${end}T00:00:00Z`,
              'modifiedSinceTimestamp': modifiedSinceTimestamp,
              'skip': skip,
              'take': take,
            },
          },
        ),
      },
    )

    const data = await textOrThrow(response, endpoint)
    const parsed: CompassApiResponseEnvelope<PeriodAttendanceLine> = JSON.parse(
      data,
    )
    if (parsed.d?.success === false) {
      throw new Error(
        `Compass API ${endpoint} reported failure: ${
          parsed.d.errorMessage ?? '(no error message)'
        }`,
      )
    }
    if (!Array.isArray(parsed.d?.data)) {
      throw new Error(
        `Compass API ${endpoint} returned an unexpected shape (expected an array in "d.data"): ${
          data.slice(0, 500)
        }`,
      )
    }
    if (!onPage) {
      lines.push(...parsed.d.data)
    }
    total = parsed.d.total
    skip += take
    const fetched = Math.min(skip, total)
    const percent = total > 0 ? ((fetched / total) * 100).toFixed(1) : '100.0'
    log(
      `attendanceGetPeriodLinesBetweenBounds: ${endpoint} responded ${response.status}, page of ${parsed.d.data.length} rows — fetched ${fetched}/${total} (${percent}%)`,
    )
    if (onPage) {
      await onPage(parsed.d.data)
    }
  }

  return lines
}

export async function attendanceGetLines(start: string, end: string): Promise<
  Array<AttendancePeriodLine>
> {
  const endpoint = '/api/attendance/v3/GetLines'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {
          'lBound': `${start}T00:00:00Z`,
          'uBound': `${end}T00:00:00Z`,
          'modifiedSince': '2016-06-10T00:00:00Z',
          'sliceType': 30,
        },
      ),
    },
  )

  const data = await response.text()
  log(`attendanceGetLines: ${endpoint} responded ${response.status}`)
  return JSON.parse(data)
}

export async function chronicleGetChronicleEntries(): Promise<
  Array<ChronicleEntry>
> {
  const endpoint = '/API/V4/Chronicle/GetChronicleEntries'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {
          'request': {
            'modifiedSinceTimestamp': '2025-01-01T05:46:30Z',
            'skip': 0,
            'year': 2026,
            'includeArchived': false,
            'excludeTemplates': [
              'Comment',
            ],
          },
        },
      ),
    },
  )

  const data = await response.text()
  log(`chronicleGetChronicleEntries: ${endpoint} responded ${response.status}`)
  return JSON.parse(data)
}

export async function referenceGetFormGroup(): Promise<Array<FormGroup>> {
  const endpoint = '/api/reference/v4/GetFormGroups'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        'request': {
          'modifiedSinceTimestamp': '2024-01-01T00:00:00Z',
          'take': 100,
          'includeArchived': false,
        },
      }),
    },
  )

  const data = await response.text()
  log(`referenceGetFormGroup: ${endpoint} responded ${response.status}`)
  return JSON.parse(data)
}

// claude: lighter, better-matching alternative to personGetStudents — confirmed
// claude: 404/415 (97%) match rate against a 1000-row period-lines sample, vs 940/1000
// claude: (94%) via personGetStudents. Preferred source for assembleAttendanceReport.
export async function personGetStudentsBasic(): Promise<Array<StudentBasic>> {
  const endpoint = '/api/person/v1/GetStudentsBasic'

  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        'request': {
          'userStatusesToInclude': [
            1,
            2,
            3,
            4,
            10,
            25,
          ],
        },
      }),
    },
  )

  const data = await textOrThrow(response, endpoint)
  const parsed: CompassFlatArrayEnvelope<StudentBasic> = JSON.parse(data)
  if (!Array.isArray(parsed.d)) {
    throw new Error(
      `Compass API ${endpoint} returned an unexpected shape (expected an array in "d"): ${
        data.slice(0, 500)
      }`,
    )
  }
  log(
    `personGetStudentsBasic: ${endpoint} responded ${response.status}, ${parsed.d.length} students`,
  )
  return parsed.d
}
