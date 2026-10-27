// the school's teaching periods, as Compass's periodCode values in timetable
// order — from deno.env's TEACHING_PERIODS, e.g. "1,2,3,4,5,6" for a
// six-period day or "1,2,3,4" for a four-period one. Per-school, so not a
// committed literal: every school's timetable is different, and the
// non-teaching blocks around the periods (before/after school, recess,
// lunch — "BS", "R", "L1", "AS" and so on) aren't wanted in any figure.
//
// Required rather than defaulted, matching the rest of deno.env: a school
// whose day isn't 1-6 would otherwise get a daily breakdown with empty
// columns and no error. `./run.sh query period-codes <date>` lists the codes
// a school's Compass actually uses.
const raw = Deno.env.get('TEACHING_PERIODS')
if (!raw) {
  throw new Error('TEACHING_PERIODS is not set in deno.env')
}

const codes = raw.split(',').map((s) => s.trim())
const invalid = codes.filter((code) => !/^[A-Za-z0-9]+$/.test(code))
if (invalid.length > 0) {
  throw new Error(
    `TEACHING_PERIODS must be a comma-separated list of Compass period codes in deno.env, e.g. "1,2,3,4" (got "${raw}")`,
  )
}
const duplicates = codes.filter((code, i) => codes.indexOf(code) !== i)
if (duplicates.length > 0) {
  throw new Error(
    `TEACHING_PERIODS lists ${
      [...new Set(duplicates)].join(', ')
    } more than once in deno.env`,
  )
}

export const TEACHING_PERIOD_CODES: readonly string[] = codes
const teachingPeriodCodeSet = new Set(codes)

// whether a period line counts towards anything: attendance %, day counts,
// the daily breakdown, away streaks and the status-group breakdown. Both
// conditions, so a block Compass happens to mark as teaching time but the
// school doesn't list (or a listed code on a non-teaching line) is ignored.
// The one place this is decided — called once per line on full years of
// data, hence the Set.
export function isTeachingPeriod(
  line: { teachingTime: boolean; periodCode: string },
): boolean {
  return line.teachingTime && teachingPeriodCodeSet.has(line.periodCode)
}

// column heading for a period in the emails: "P1" for a numeric code (as the
// reports have always shown), the code itself otherwise (e.g. "A").
export function periodLabel(code: string): string {
  return /^\d+$/.test(code) ? `P${code}` : code
}
