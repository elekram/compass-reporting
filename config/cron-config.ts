import {
  allReportKeys,
  ENABLED_PREFIX,
  RECIPIENTS_PREFIX,
  registryReportKeys,
  ReportEnvKeys,
  statusGroupReportKeys,
} from './report-env-keys.ts'

export interface ScheduledReport {
  reportId: string
  // per-report on/off switch — cron.ts skips any entry with enabled: false
  // entirely (no sync dependency, just skipped at send time). From the
  // report's REPORT_ENABLED_<id> variable in deno.env (see below).
  enabled: boolean
  // real recipient addresses. Ignored entirely while debugMode is true (see
  // below).
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

// which reports go out on the daily schedule, and to whom, lives in deno.env
// rather than as committed literals — both are per-school. Two variables per
// report (names from report-env-keys.ts):
//   REPORT_ENABLED_<id>    — required, exactly "true" or "false". Kept
//                            separate from the recipient list so a report
//                            can be switched off and back on without
//                            touching (or losing) its addresses.
//   REPORT_RECIPIENTS_<id> — comma-separated addresses; required only when
//                            the report is enabled.
// the switch is required rather than defaulted, matching CRON_DEBUG_MODE: a
// deployment missing it (say, a server pulled without its deno.env updated)
// fails at startup instead of quietly sending nothing every morning while the
// sync reports OK. Disabled reports are still sendable by hand via
// send-report.
function readEnabled(key: string): boolean {
  const raw = Deno.env.get(key)
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      `${key} must be exactly "true" or "false" in deno.env (got ${
        raw === undefined ? 'unset' : `"${raw}"`
      })`,
    )
  }
  return raw === 'true'
}

function readRecipients(key: string): string[] {
  const recipients = (Deno.env.get(key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const invalid = recipients.filter((address) => !address.includes('@'))
  if (invalid.length > 0) {
    throw new Error(
      `${key} in deno.env has invalid email address(es): ${invalid.join(', ')}`,
    )
  }
  return recipients
}

function readReportSchedule(keys: ReportEnvKeys): ScheduledReport {
  const enabled = readEnabled(keys.enabledKey)
  const recipients = readRecipients(keys.recipientsKey)
  // an enabled report with nobody to send to would just be skipped every
  // morning with a log line — refused here instead, since it can only mean a
  // missing or emptied recipients variable.
  if (enabled && recipients.length === 0) {
    throw new Error(
      `${keys.enabledKey} is true but ${keys.recipientsKey} is not set in deno.env`,
    )
  }
  return { reportId: keys.reportId, enabled, recipients }
}

// a misspelt variable name would otherwise just be ignored — refused at
// startup instead, with the valid names listed.
const knownKeys = allReportKeys.flatMap((k) => [k.enabledKey, k.recipientsKey])
const unknownKeys = Object.keys(Deno.env.toObject()).filter((key) =>
  (key.startsWith(ENABLED_PREFIX) || key.startsWith(RECIPIENTS_PREFIX)) &&
  !knownKeys.includes(key)
)
if (unknownKeys.length > 0) {
  throw new Error(
    `deno.env has unknown report variable(s): ${unknownKeys.join(', ')}. Valid names: ${
      knownKeys.join(', ')
    }`,
  )
}

const scheduledReports: ScheduledReport[] = registryReportKeys.map(readReportSchedule)

const { enabled: statusGroupEnabled, recipients: statusGroupRecipients } =
  readReportSchedule(statusGroupReportKeys)
const statusGroupReport: StatusGroupReportSchedule = {
  enabled: statusGroupEnabled,
  recipients: statusGroupRecipients,
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
  // school-local time (24h "HH:MM", in deno.env's SCHOOL_TIMEZONE) the daily
  // sync + report run fires. cron.ts checks this against the current
  // school-local wall-clock time on a 5-minute tick rather than baking a fixed
  // UTC cron expression, so it stays correct across daylight-saving
  // changeovers without needing a manual twice-yearly adjustment. Must land on a 5-minute mark (:00/:05/
  // :10/etc) to actually line up with that tick.
  runTimeLocal: '07:30',

  // weekly firing, same 5-minute-tick mechanism as runTimeLocal — runs a
  // cheap DB-vs-Compass row count check (see sync.ts's
  // checkPeriodLineDiscrepancy) and, only if it finds a gap, a full-term
  // forced resync to close it. Deliberately well after the morning run and
  // the school day's marking, so a resync (if triggered) has all evening/
  // overnight to finish. Must also land on a 5-minute mark.
  eveningCheckTimeLocal: '21:00',

  // which school-local weekday (config/timezone.ts's schoolWeekdayShort format —
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

  // one entry per report in reports/registry.ts, in registry order — on or
  // off per its REPORT_ENABLED_<id> variable in deno.env (see above). A
  // disabled report is simply never sent automatically — it's still
  // reachable manually via `deno task send-report -- <id> <email>`.
  reports: scheduledReports,

  // principal-facing whole-school/per-year-level status-group breakdown
  // (status-group-report.ts) — sent daily, right after the per-student
  // reports above, from the same freshly synced data. Switched by
  // REPORT_ENABLED_STATUS_GROUP_BREAKDOWN in deno.env.
  statusGroupReport,
}

export default cronConfig
