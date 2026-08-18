import './check-env.ts'
import config from './config/config.ts'
import cronConfig from './config/cron-config.ts'
import { runEveningCheckAndEmail, runSyncAndEmail } from './sync.ts'
import {
  buildFullReportData,
  buildSubjectLine,
  getStudentAttendance,
} from './attendance-data.ts'
import { getReport } from './reports/registry.ts'
import emailTemplate from './email-templates/email-template.ts'
import { sendMail } from './mailer.ts'
import { endRun, log, logError, startRun } from './logger.ts'

const MELBOURNE_TIMEZONE = 'Australia/Melbourne'

// "HH:MM" in Melbourne local time, DST-aware via Intl (unlike a fixed UTC
// cron expression, this doesn't need manual adjustment at the AEST/AEDT
// changeover — see cronConfig.runTimeLocal).
function currentMelbourneTime(): string {
  return new Date().toLocaleTimeString('en-AU', {
    timeZone: MELBOURNE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// "Mon"/"Tue"/etc in Melbourne local time — shared by the weekday gate below
// and the evening check's single-weekday gate (cronConfig.eveningCheckDayLocal).
function currentMelbourneWeekday(): string {
  return new Date().toLocaleDateString('en-AU', {
    timeZone: MELBOURNE_TIMEZONE,
    weekday: 'short',
  })
}

// school days only — Compass itself doesn't move on weekends, so a
// Saturday/Sunday run would just re-sync an unchanged window and send
// reports with nothing new to say.
function isMelbourneWeekday(): boolean {
  const day = currentMelbourneWeekday()
  return day !== 'Sat' && day !== 'Sun'
}

// sends every enabled report in cronConfig.reports, sequentially, against
// one shared year/term dataset fetch — mirrors send-report.ts's per-report
// flow but loops instead of taking a single report id from argv.
async function sendScheduledReports() {
  const [yearDataset, termDataset] = await Promise.all([
    getStudentAttendance(config.year),
    getStudentAttendance(config.getCurrentTerm()),
  ])

  const enabledReports = cronConfig.reports.filter((entry) => entry.enabled)
  let sentCount = 0

  for (const entry of cronConfig.reports) {
    if (!entry.enabled) {
      continue
    }

    const recipients = cronConfig.debugMode
      ? cronConfig.debugRecipients
      : entry.recipients
    if (recipients.length === 0) {
      log(`cron.ts: skipping "${entry.reportId}" — no recipients configured`)
      continue
    }

    const def = getReport(entry.reportId)
    const data = await buildFullReportData(yearDataset, termDataset, def)
    const html = emailTemplate(data)
    const subject = buildSubjectLine(def, data)

    await sendMail({ to: recipients, subject, html })
    sentCount++
    log(
      `cron.ts: sent "${subject}" to ${
        recipients.join(', ')
      } (${sentCount}/${enabledReports.length})`,
    )
  }
}

async function runDailyJob() {
  const logPath = startRun('cron-daily')
  log(`cron.ts: daily job starting, logging to ${logPath}`)

  try {
    const { ok } = await runSyncAndEmail()

    if (!ok) {
      logError('cron.ts: sync failed — skipping report sends')
      return
    }

    log('cron.ts: sync ok, sending scheduled reports')
    await sendScheduledReports()
    log('cron.ts: daily job complete')
  } finally {
    endRun()
  }
}

// Deno.cron schedules are UTC-only (see docs.deno.com/runtime/fundamentals/
// cron) with no timezone parameter, so rather than bake a fixed UTC offset
// in (which would drift an hour at every AEST/AEDT changeover), this ticks
// every 5 minutes and only actually runs the job when the Melbourne
// wall-clock time matches cronConfig.runTimeLocal. Deno.cron guarantees
// non-overlapping executions of the same job on its own, so there's no risk
// of two ticks racing each other.
Deno.cron('daily-sync-and-reports', '*/5 * * * *', async () => {
  if (currentMelbourneTime() !== cronConfig.runTimeLocal) {
    return
  }
  if (!isMelbourneWeekday()) {
    log('cron.ts: skipping — weekend')
    return
  }
  await runDailyJob()
})

// second tick, same non-overlap/no-catch-up caveats as the job above — see
// sync.ts's runEveningCheckAndEmail for what this actually does (nothing
// unless it finds a period-line discrepancy) and for its own log-run
// handling (no wrapping needed here, unlike runDailyJob — there's nothing
// else in this tick to share a log file with). Fires weekly, not nightly —
// see cronConfig.eveningCheckDayLocal for why.
Deno.cron('evening-discrepancy-check', '*/5 * * * *', async () => {
  if (currentMelbourneTime() !== cronConfig.eveningCheckTimeLocal) {
    return
  }
  if (currentMelbourneWeekday() !== cronConfig.eveningCheckDayLocal) {
    return
  }
  await runEveningCheckAndEmail()
})

console.log(
  `cron.ts: registered — daily job fires at ${cronConfig.runTimeLocal} ${MELBOURNE_TIMEZONE}, evening discrepancy check fires at ${cronConfig.eveningCheckTimeLocal} ${MELBOURNE_TIMEZONE} on ${cronConfig.eveningCheckDayLocal}s (debugMode: ${cronConfig.debugMode})`,
)

// registering the cron job above is enough to keep the process (and the
// shared sql pool imported transitively via sync.ts/attendance-data.ts)
// alive indefinitely — no explicit event-loop keep-alive needed, and unlike
// sync.ts/send-report.ts, sql.end() is intentionally never called here since
// this process is meant to run for months, not exit after one job.
