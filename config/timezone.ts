// the school's IANA timezone (e.g. "Australia/Melbourne"), from deno.env so
// the same code can run for a school anywhere. Used for everything that
// depends on the school's local calendar day or wall-clock time: cron.ts's
// schedule gate, sync.ts's fetch window, and attendance-data.ts's
// local-day grouping in SQL (`AT TIME ZONE`). Deliberately separate from TZ
// (which only sets the process's default zone) so nothing here depends on how
// the container happens to be configured.
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
