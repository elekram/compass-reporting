export interface ScheduledReport {
  reportId: string
  // claude: per-report on/off switch — cron.ts skips any entry with enabled: false
  // claude: entirely (no sync dependency, just skipped at send time).
  enabled: boolean
  // claude: real coordinator addresses — TODO: fill these in before turning
  // claude: debugMode off. Ignored entirely while debugMode is true (see below).
  recipients: string[]
}

const cronConfig = {
  // claude: Melbourne local time (24h "HH:MM") the daily sync + report run fires.
  // claude: cron.ts checks this against the current Australia/Melbourne wall-clock
  // claude: time on a 5-minute tick rather than baking a fixed UTC cron expression,
  // claude: so it stays correct across the AEST/AEDT changeover without needing a
  // claude: manual twice-yearly adjustment. Must land on a 5-minute mark (:00/:05/
  // claude: :10/etc) to actually line up with that tick.
  runTimeLocal: '06:30',

  // claude: while true, every report email cron.ts sends goes to debugRecipients
  // claude: instead of that report's own `recipients` — lets you test the full daily
  // claude: pipeline (sync + all enabled reports) without coordinators receiving
  // claude: anything. The sync summary/failure email (config/mail-config.ts's
  // claude: syncSummaryRecipients) is unaffected by this flag — it always goes to
  // claude: the ops address, debug or not.
  debugMode: true,
  debugRecipients: ['lee@cheltsec.vic.edu.au'],

  // claude: one entry per report in reports/registry.ts that should be sent on the
  // claude: daily schedule. A report id with no entry here (or enabled: false) is
  // claude: simply never sent automatically — it's still reachable manually via
  // claude: `deno task send-report -- <id> <email>`.
  reports: [
    { reportId: 'explained-absences-year-7', enabled: true, recipients: [] },
    { reportId: 'explained-absences-year-8', enabled: true, recipients: [] },
    { reportId: 'explained-absences-year-9', enabled: true, recipients: [] },
    { reportId: 'explained-absences-year-10', enabled: true, recipients: [] },
    { reportId: 'explained-absences-year-11', enabled: true, recipients: [] },
    { reportId: 'explained-absences-year-12', enabled: true, recipients: [] },
    // claude: whole-school reports — off by default, not part of the year-level
    // claude: cadence this was built for. Flip on once there's a real audience for
    // claude: them (see the open heading-ambiguity caveat on these two reports).
    { reportId: 'explained-absences', enabled: false, recipients: [] },
    { reportId: 'unexplained-absences', enabled: false, recipients: [] },
  ] satisfies ScheduledReport[],
}

export default cronConfig
