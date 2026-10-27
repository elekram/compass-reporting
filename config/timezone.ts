// the school's IANA timezone (e.g. "Australia/Melbourne"), from deno.env so
// the same code can run for a school anywhere — and the one place every
// date/time calculation in the app goes through. Deliberately separate from
// TZ (which only sets the process's default zone) so nothing here depends on
// how the container happens to be configured.
//
// Two kinds of value, kept apart:
//   - instants (a JS Date, a timestamptz column, Compass's "...Z" strings) —
//     an exact moment, meaningless as a "day" until read in a timezone.
//   - school dates ("YYYY-MM-DD" strings) — a calendar day at the school.
//     Every term, range, "today" and daily-breakdown day is one of these.
// Converting the first into the second always goes through schoolDateIso()
// here (or SQL's `AT TIME ZONE SCHOOL_TIMEZONE`, which attendance-data.ts
// wraps). Never take the date part of an instant's UTC string
// (toISOString().substring(0, 10)): for a school east of UTC that's the
// previous day for anything before ~10-11am, which is how both the
// day-count and the date-range bugs happened.
const schoolTimezone = Deno.env.get('SCHOOL_TIMEZONE')
if (!schoolTimezone) {
  throw new Error('SCHOOL_TIMEZONE is not set in deno.env')
}

// Intl throws a RangeError for an unknown zone — checked at startup so a typo
// fails loudly here rather than as a confusing error mid-job (or, worse, an
// abbreviation like "AEST" that Postgres accepts as a fixed offset with no
// daylight saving).
try {
  new Intl.DateTimeFormat('en-AU', { timeZone: schoolTimezone })
} catch {
  throw new Error(
    `SCHOOL_TIMEZONE must be an IANA timezone name in deno.env, e.g. "Australia/Melbourne" (got "${schoolTimezone}")`,
  )
}
if (!schoolTimezone.includes('/') && schoolTimezone !== 'UTC') {
  throw new Error(
    `SCHOOL_TIMEZONE must be an IANA timezone name like "Australia/Melbourne", not an abbreviation (got "${schoolTimezone}")`,
  )
}

export const SCHOOL_TIMEZONE = schoolTimezone

// the school-local calendar date (YYYY-MM-DD) at a given instant. Not
// date.toISOString()'s UTC date: for a school east of UTC, the morning run
// happens on the *previous* UTC day (07:30 in Melbourne is 20:30 or 21:30 UTC
// the day before), which made the first school day of every term look like
// a holiday. The 'en-CA' locale is only there because it formats as
// YYYY-MM-DD.
//
// The formatter is built once: date.toLocaleDateString(…, { timeZone })
// constructs a new Intl formatter on every call (~35µs), which made a full
// year's report spend ~40s just converting period-line dates.
const schoolDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function schoolDateIso(date: Date = new Date()): string {
  return schoolDateFormat.format(date)
}

// schoolDateIso for an instant given as an ISO string — a period line's
// `start`. Remembered per instant: every student's period 1 on a given day
// shares the same start, so a whole year has only a few thousand distinct
// instants across a million-plus lines, and each is converted once. The
// cache only ever holds period start times, so it stays that size even in
// cron.ts's long-running process.
const schoolDateByInstant = new Map<string, string>()

export function schoolDateOfInstant(isoInstant: string): string {
  let date = schoolDateByInstant.get(isoInstant)
  if (date === undefined) {
    date = schoolDateIso(new Date(isoInstant))
    schoolDateByInstant.set(isoInstant, date)
  }
  return date
}

// the most recent school date that's fully over — yesterday, school-local.
// The upper bound for every "up to now" range in the reports, so a morning
// run never counts today's periods (which exist in Compass ahead of time,
// unmarked) and a manual run later in the day gives the same figures as
// the 07:30 one. Same rule the daily breakdown's "complete days" use.
export function lastCompleteSchoolDateIso(date: Date = new Date()): string {
  return addDaysIso(schoolDateIso(date), -1)
}

// "HH:MM" (24h) school-local wall-clock time — what cron.ts compares
// runTimeLocal/eveningCheckTimeLocal against. The 'en-AU' locale only fixes
// the format.
export function schoolTimeHHMM(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-AU', {
    timeZone: SCHOOL_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// "Mon"/"Tue"/etc for the school-local day at an instant — cron.ts's
// weekday gates (and cronConfig.eveningCheckDayLocal's format).
export function schoolWeekdayShort(date: Date = new Date()): string {
  return date.toLocaleDateString('en-AU', {
    timeZone: SCHOOL_TIMEZONE,
    weekday: 'short',
  })
}

// ---- pure calendar arithmetic on school dates ----
// a school date has no time or zone of its own, so these treat it as UTC
// midnight purely as a calendar device (UTC has no daylight saving, so
// adding a day always moves exactly one calendar day). Never mix their
// intermediate Date with an instant.

function calendarDate(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00Z`)
}

// a real YYYY-MM-DD calendar date — the round-trip catches dates that parse
// but roll over, e.g. 2026-02-30 -> 2026-03-02. Used to validate TERM_n.
export function isValidDateIso(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const d = calendarDate(value)
  return !Number.isNaN(d.getTime()) && d.toISOString().substring(0, 10) === value
}

export function addDaysIso(dateIso: string, days: number): string {
  const d = calendarDate(dateIso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().substring(0, 10)
}

// ---- Compass fetch windows ----
// Compass's lBound/uBound are sent as `${date}T00:00:00Z` — *instants*, not
// school dates (see attendanceGetPeriodLinesBetweenBounds) — so for a
// Melbourne school a bound of "2026-08-10" is 10am/11am local on the 10th,
// not local midnight. Both edges of every fetch window are therefore padded
// by a day, so a window always covers whole school days. Fetching the extra
// part-days is harmless: upserts are idempotent and everything downstream
// filters by school date. Used by sync.ts and compass-query.ts.

// the lBound date for a window starting on firstSchoolDate. Unpadded, this
// used to leave periods 1-2 of the year's first day (and of each trailing
// resync's first day) permanently unfetched.
export function compassWindowStart(firstSchoolDate: string): string {
  return addDaysIso(firstSchoolDate, -1)
}

// the uBound date for a window ending on lastSchoolDate: UTC midnight the
// next day — past the end of that day's last period for any school east of
// roughly UTC-6, which covers every region Compass operates in. (The sync's
// window end used to be new Date().toISOString()'s UTC date: the 07:30
// Melbourne job runs at 21:30 UTC the *previous* day, so the window shut at
// 10am on the very day being reported — periods 3-6 were never fetched.)
export function compassWindowEnd(lastSchoolDate: string): string {
  return addDaysIso(lastSchoolDate, 1)
}

// weekday name of a school date, e.g. "Tuesday" / "Tue" — for email
// headings and subject lines.
export function weekdayOfDateIso(
  dateIso: string,
  style: 'long' | 'short' = 'long',
): string {
  return calendarDate(dateIso).toLocaleDateString('en-US', {
    weekday: style,
    timeZone: 'UTC',
  })
}
