// API KEY 784b981c-0c7f-4ebf-b786-f6ca9eca6050
// import { stringify } from '@std/csv'
import {
  AttendancePeriodLine,
  AttendanceStatus,
  ChronicleEntry,
  FormGroup,
  PeriodAttendanceLine,
  StudentBasic,
} from './compass-api.types.ts'

// claude: every Compass endpoint wraps its payload in a top-level "d". These three
// claude: envelope shapes were confirmed by running main.ts against the live API —
// claude: see the transcript. Kept local to this file since they're a fetch-layer
// claude: concern, not a domain type.
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

export function getHeaders() {
  const h = new Headers()

  h.append('Content-Type', 'application/json')
  h.append('CompassApiKey', '784b981c-0c7f-4ebf-b786-f6ca9eca6050')

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

  const data = await response.text()
  const parsed: CompassFlatArrayEnvelope<AttendanceStatus> = JSON.parse(data)
  return parsed.d
}

export async function attendanceGetPeriodLinesBetweenBounds(
  start: string,
  end: string,
): Promise<
  Array<PeriodAttendanceLine>
> {
  const endpoint = '/API/V4/Attendance/GetPeriodLinesTracking'
  const take = 1000
  const lines: PeriodAttendanceLine[] = []
  let skip = 0
  let total = Infinity

  // claude: skip/take pagination, not cursor-based — the envelope reports "total"
  // claude: so we page until skip catches up to it. Seen as 171612 for a 2-month
  // claude: window in testing, so a full year could mean ~1000 sequential requests;
  // claude: worth checking response time in practice before scheduling this unattended.
  while (skip < total) {
    const response = await fetch(
      `https://${getSchoolUrl()}${endpoint}`,
      {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(
          {
            'request': {
              'lBound': `${start}T00:00:00Z`,
              'uBound': `${end}T00:00:00Z`,
              'modifiedSinceTimestamp': '2023-08-01T05:46:30Z',
              'skip': skip,
              'take': take,
            },
          },
        ),
      },
    )

    const data = await response.text()
    const parsed: CompassApiResponseEnvelope<PeriodAttendanceLine> = JSON.parse(
      data,
    )
    lines.push(...parsed.d.data)
    total = parsed.d.total
    skip += take
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

  const data = await response.text()
  const parsed: CompassFlatArrayEnvelope<StudentBasic> = JSON.parse(data)
  return parsed.d
}
