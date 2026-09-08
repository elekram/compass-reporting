export interface ScheduledReport {
  reportId: string
  // per-report on/off switch — cron.ts skips any entry with enabled: false
  // entirely (no sync dependency, just skipped at send time).
  enabled: boolean
  // real coordinator addresses — TODO: fill these in before turning
  // debugMode off. Ignored entirely while debugMode is true (see below).
  recipients: string[]
}

// status-group-report.ts's report isn't a per-student ReportDefinition (see
// its own comment for why), so it isn't one of the `reports` entries below
// — it's sent by its own call in cron.ts's runDailyJob, gated by this
// separate on/off switch and recipient list.
export interface StatusGroupReportSchedule {
  enabled: boolean
  recipients: string[]
}

// late-arrivals-report.ts's "[Lates] Year X" reports aren't ReportDefinitions
// either (see their own comment for why) — sent by their own loop in
// cron.ts's runDailyJob, one entry per year level, each with its own
// on/off switch and recipient list, same shape as `reports` above.
export interface LateArrivalsReportSchedule {
  yearLevel: string
  enabled: boolean
  recipients: string[]
}

// debugMode/debugRecipients live in deno.env rather than as committed
// literals — they're per-deployment (a dev copy wants debug on, production
// wants it off), so baking them into this tracked file meant every dev clone
// carried a working-tree edit that must never be committed back.
//
// required rather than defaulted, matching mail-config.ts: an unset var
// defaulting to false would silently email real coordinators from a laptop,
// which is exactly the failure this flag exists to prevent. Parsed strictly
// for the same reason — a typo like "TRUE" must not fall through to
// production behaviour.
const debugModeRaw = Deno.env.get('CRON_DEBUG_MODE')
if (debugModeRaw !== 'true' && debugModeRaw !== 'false') {
  throw new Error(
    `CRON_DEBUG_MODE must be exactly "true" or "false" in deno.env (got ${
      debugModeRaw === undefined ? 'unset' : `"${debugModeRaw}"`
    })`,
  )
}
const debugMode = debugModeRaw === 'true'

const debugRecipients = (Deno.env.get('CRON_DEBUG_RECIPIENTS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

// without this, debugMode true + no recipients makes cron.ts skip every
// report as "no recipients configured" — a silent no-op run that looks
// healthy in the logs while sending nothing at all.
if (debugMode && debugRecipients.length === 0) {
  throw new Error(
    'CRON_DEBUG_MODE is true but CRON_DEBUG_RECIPIENTS is empty — every report would be skipped',
  )
}

const cronConfig = {
  // Melbourne local time (24h "HH:MM") the daily sync + report run fires.
  // cron.ts checks this against the current Australia/Melbourne wall-clock
  // time on a 5-minute tick rather than baking a fixed UTC cron expression,
  // so it stays correct across the AEST/AEDT changeover without needing a
  // manual twice-yearly adjustment. Must land on a 5-minute mark (:00/:05/
  // :10/etc) to actually line up with that tick.
  runTimeLocal: '07:30',

  // weekly firing, same 5-minute-tick mechanism as runTimeLocal — runs a
  // cheap DB-vs-Compass row count check (see sync.ts's
  // checkPeriodLineDiscrepancy) and, only if it finds a gap, a full-term
  // forced resync to close it. Deliberately well after the morning run and
  // the school day's marking, so a resync (if triggered) has all evening/
  // overnight to finish. Must also land on a 5-minute mark.
  eveningCheckTimeLocal: '21:00',

  // which Melbourne weekday (cron.ts's currentMelbourneWeekday format —
  // "Mon"/"Tue"/etc) the evening check fires on. Weekly rather than nightly:
  // the full-term resync it can trigger processes 10x the rows the old daily
  // trailing-resync-only baseline did, and running it every weeknight left
  // the process's V8 heap high-water-mark elevated going into the very next
  // morning's report generation — the heaviest single step this app does —
  // with only ~6-7 hours for it to settle. Confirmed cause of a 2026-08-18
  // OOM crash. Friday gives it the whole weekend (no cron jobs fire on
  // Sat/Sun) before Monday's report run. Any drift within the last 14 days
  // still self-heals every single morning regardless, via runSync's own
  // trailing resync — this only affects how quickly *older* drift gets
  // caught and escalated.
  eveningCheckDayLocal: 'Fri',

  // while true, every report email cron.ts sends goes to debugRecipients
  // instead of that report's own `recipients` — lets you test the full daily
  // pipeline (sync + all enabled reports) without coordinators receiving
  // anything. The sync summary/failure email (config/mail-config.ts's
  // syncSummaryRecipients) is unaffected by this flag — it always goes to
  // the ops address, debug or not. Both values come from deno.env — see the
  // CRON_DEBUG_MODE parsing above.
  debugMode,
  debugRecipients,

  // one entry per report in reports/registry.ts that should be sent on the
  // daily schedule. A report id with no entry here (or enabled: false) is
  // simply never sent automatically — it's still reachable manually via
  // `deno task send-report -- <id> <email>`.
  reports: [
    {
      reportId: 'explained-absences-year-7',
      enabled: true,
      recipients: [
        'middleschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      reportId: 'explained-absences-year-8',
      enabled: true,
      recipients: [
        'middleschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      reportId: 'explained-absences-year-9',
      enabled: true,
      recipients: [
        'middleschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      reportId: 'explained-absences-year-10',
      enabled: true,
      recipients: [
        'seniorschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      reportId: 'explained-absences-year-11',
      enabled: true,
      recipients: [
        'seniorschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      reportId: 'explained-absences-year-12',
      enabled: true,
      recipients: [
        'seniorschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    // whole-school reports — off by default, not part of the year-level
    // cadence this was built for. Flip on once there's a real audience for
    // them (see the open heading-ambiguity caveat on these two reports).
    { reportId: 'explained-absences', enabled: false, recipients: [] },
    { reportId: 'unexplained-absences', enabled: false, recipients: [] },
  ] satisfies ScheduledReport[],

  // principal-facing whole-school/per-year-level status-group breakdown
  // (status-group-report.ts) — sent daily, right after the per-student
  // reports above, from the same freshly synced data.
  statusGroupReport: {
    enabled: true,
    recipients: [
      'principalclass@cheltsec.vic.edu.au',
      'lee@cheltsec.vic.edu.au',
    ],
  } satisfies StatusGroupReportSchedule,

  // per-year-level "[Lates] Year X" late-arrivals-at-school reports — same
  // recipient split as the explained-absences-year-X reports above
  // (middleschool coordinators for 7-9, senior school coordinators for
  // 10-12), sent daily alongside them.
  lateArrivalsReports: [
    {
      yearLevel: '7',
      enabled: true,
      recipients: [
        'middleschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      yearLevel: '8',
      enabled: true,
      recipients: [
        'middleschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      yearLevel: '9',
      enabled: true,
      recipients: [
        'middleschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      yearLevel: '10',
      enabled: true,
      recipients: [
        'seniorschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      yearLevel: '11',
      enabled: true,
      recipients: [
        'seniorschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
    {
      yearLevel: '12',
      enabled: true,
      recipients: [
        'seniorschoolcoordinators@cheltsec.vic.edu.au',
        'principalclass@cheltsec.vic.edu.au',
        'lee@cheltsec.vic.edu.au',
      ],
    },
  ] satisfies LateArrivalsReportSchedule[],
}

export default cronConfig
