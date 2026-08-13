// ad-hoc CLI for poking at raw Compass API responses directly — for
// exploring a new endpoint's shape or spot-checking data without writing a
// throwaway script and deleting it afterwards. Not part of the sync/report
// pipeline (see sync.ts/report.ts/send-report.ts) — those go through
// Postgres, this always hits Compass live.
import * as compassApi from './api/compass-api.ts'

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
}

const [name, ...rest] = Deno.args.filter((arg) => arg !== '--')

if (!name || !(name in QUERIES)) {
  console.error('Usage: deno task query -- <query> [args...]')
  console.error(`Available queries: ${Object.keys(QUERIES).join(', ')}`)
  Deno.exit(1)
}

const result = await QUERIES[name](rest)

if (Array.isArray(result)) {
  console.log(`${result.length} results\n`)
}
console.log(JSON.stringify(result, null, 2))
