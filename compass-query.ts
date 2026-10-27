// ad-hoc CLI for poking at raw Compass API responses directly — for
// exploring a new endpoint's shape or spot-checking data without writing a
// throwaway script and deleting it afterwards. Not part of the sync/report
// pipeline (see sync.ts/report.ts/send-report.ts) — those go through
// Postgres, this always hits Compass live.
import * as compassApi from './api/compass-api.ts'
import { groupBy } from './collections.ts'

type Query = (args: string[]) => Promise<unknown>

const QUERIES: Record<string, Query> = {
  statuses: () => compassApi.attendanceGetStatuses(),
  students: () => compassApi.personGetStudentsBasic(),
  'form-groups': () => compassApi.referenceGetFormGroup(),
  chronicle: () => compassApi.chronicleGetChronicleEntries(),
  // [start, end] as YYYY-MM-DD, e.g. `2026-07-01 2026-08-01`.
  lines: ([start, end]) => {
    if (!start || !end) {
      throw new Error('lines requires <start> <end>, e.g. 2026-07-01 2026-08-01')
    }
    return compassApi.attendanceGetLines(start, end)
  },
  // [start, end, modifiedSinceTimestamp?] — same bounds sync.ts uses, but a
  // single unpaginated-looking call here (attendanceGetPeriodLinesBetweenBounds
  // still pages internally, just without sync.ts's onPage/startSkip/self-heal
  // machinery — this is for looking, not syncing).
  'period-lines': ([start, end, modifiedSince]) => {
    if (!start || !end) {
      throw new Error(
        'period-lines requires <start> <end> [modifiedSinceTimestamp], e.g. 2026-07-01 2026-08-01',
      )
    }
    return compassApi.attendanceGetPeriodLinesBetweenBounds(start, end, modifiedSince)
  },
  // [schoolDate] — which period codes a school's Compass uses on one day,
  // for setting TEACHING_PERIODS on a new deployment: each code's usual
  // local start time, whether Compass marks it as teaching time, and whether
  // TEACHING_PERIODS already lists it. Needs SCHOOL_TIMEZONE, but not
  // TEACHING_PERIODS (that's what it's for), nor a sync or a database.
  'period-codes': async ([schoolDate]) => {
    if (!schoolDate) {
      throw new Error(
        'period-codes requires <school date>, e.g. 2026-10-20 (pick a normal school day)',
      )
    }
    const { compassWindowEnd, compassWindowStart, schoolDateOfInstant, schoolTimeHHMM } =
      await import('./config/timezone.ts')
    const isListed = await import('./config/periods.ts')
      .then((periods) => (code: string) => periods.TEACHING_PERIOD_CODES.includes(code))
      .catch(() => null)

    const lines = (await compassApi.attendanceGetPeriodLinesBetweenBounds(
      compassWindowStart(schoolDate),
      compassWindowEnd(schoolDate),
    )).filter((line) => schoolDateOfInstant(line.start) === schoolDate)

    const rows = [...groupBy(lines, (line) => line.periodCode)].map(
      ([code, codeLines]) => {
        // the start time most of this code's lines share (a few may differ)
        const startCounts = groupBy(
          codeLines,
          (line) => schoolTimeHHMM(new Date(line.start)),
        )
        const [usualStart] = [...startCounts].sort((a, b) => b[1].length - a[1].length)[0]
        const teaching = codeLines.filter((line) => line.teachingTime).length
        return {
          code,
          'usual start': usualStart,
          lines: codeLines.length,
          'teaching time (Compass)': teaching === codeLines.length
            ? 'yes'
            : teaching === 0
            ? 'no'
            : `mixed (${teaching}/${codeLines.length})`,
          'in TEACHING_PERIODS': isListed ? (isListed(code) ? 'yes' : 'no') : '(not set)',
        }
      },
    ).sort((a, b) => a['usual start'].localeCompare(b['usual start']))

    console.log(`Period codes on ${schoolDate} (${lines.length} lines):`)
    console.table(rows)
    console.log(
      'Set TEACHING_PERIODS in deno.env to the codes of the periods to report on, in order,',
    )
    console.log(
      'usually the ones Compass marks as teaching time, e.g. TEACHING_PERIODS=1,2,3,4.',
    )
    return undefined
  },
}

const [name, ...rest] = Deno.args.filter((arg) => arg !== '--')

if (!name || !(name in QUERIES)) {
  console.error('Usage: ./run.sh query <query> [args...]')
  console.error(`Available queries: ${Object.keys(QUERIES).join(', ')}`)
  Deno.exit(1)
}

const result = await QUERIES[name](rest)

// a query that prints its own summary (period-codes) returns nothing
if (result !== undefined) {
  if (Array.isArray(result)) {
    console.log(`${result.length} results\n`)
  }
  console.log(JSON.stringify(result, null, 2))
}
