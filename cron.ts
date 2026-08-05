import config from './config/config.ts'
import cronConfig from './config/cron-config.ts'
import { runSyncAndEmail } from './sync.ts'
import {
  buildFullReportData,
  buildSubjectLine,
  getStudentAttendance,
} from './attendance-data.ts'
import { getReport } from './reports/registry.ts'
import emailTemplate from './email-templates/email-template.ts'
import { sendMail } from './mailer.ts'

const MELBOURNE_TIMEZONE = 'Australia/Melbourne'

// claude: "HH:MM" in Melbourne local time, DST-aware via Intl (unlike a fixed UTC
// claude: cron expression, this doesn't need manual adjustment at the AEST/AEDT
// claude: changeover — see cronConfig.runTimeLocal).
function currentMelbourneTime(): string {
  return new Date().toLocaleTimeString('en-AU', {
    timeZone: MELBOURNE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// claude: sends every enabled report in cronConfig.reports, sequentially, against
// claude: one shared year/term dataset fetch — mirrors send-report.ts's per-report
// claude: flow but loops instead of taking a single report id from argv.
async function sendScheduledReports() {
  const [yearDataset, termDataset] = await Promise.all([
    getStudentAttendance(config.year),
    getStudentAttendance(config.getCurrentTerm()),
  ])

  for (const entry of cronConfig.reports) {
    if (!entry.enabled) {
      continue
    }

    const recipients = cronConfig.debugMode
      ? cronConfig.debugRecipients
      : entry.recipients
    if (recipients.length === 0) {
      console.log(
        `cron.ts: skipping "${entry.reportId}" — no recipients configured`,
      )
      continue
    }

    const def = getReport(entry.reportId)
    const data = await buildFullReportData(yearDataset, termDataset, def)
    const html = emailTemplate(data)
    const subject = buildSubjectLine(def, data)

    await sendMail({ to: recipients, subject, html })
    console.log(`cron.ts: sent "${subject}" to ${recipients.join(', ')}`)
  }
}

async function runDailyJob() {
  console.log('cron.ts: daily job starting (sync)')
  const { ok } = await runSyncAndEmail()

  if (!ok) {
    console.error('cron.ts: sync failed — skipping report sends')
    return
  }

  console.log('cron.ts: sync ok, sending scheduled reports')
  await sendScheduledReports()
  console.log('cron.ts: daily job complete')
}

// claude: Deno.cron schedules are UTC-only (see docs.deno.com/runtime/fundamentals/
// claude: cron) with no timezone parameter, so rather than bake a fixed UTC offset
// claude: in (which would drift an hour at every AEST/AEDT changeover), this ticks
// claude: every 5 minutes and only actually runs the job when the Melbourne
// claude: wall-clock time matches cronConfig.runTimeLocal. Deno.cron guarantees
// claude: non-overlapping executions of the same job on its own, so there's no risk
// claude: of two ticks racing each other.
Deno.cron('daily-sync-and-reports', '*/5 * * * *', async () => {
  if (currentMelbourneTime() !== cronConfig.runTimeLocal) {
    return
  }
  await runDailyJob()
})

console.log(
  `cron.ts: registered — daily job fires at ${cronConfig.runTimeLocal} ${MELBOURNE_TIMEZONE} (debugMode: ${cronConfig.debugMode})`,
)

// claude: registering the cron job above is enough to keep the process (and the
// claude: shared sql pool imported transitively via sync.ts/attendance-data.ts)
// claude: alive indefinitely — no explicit event-loop keep-alive needed, and unlike
// claude: sync.ts/send-report.ts, sql.end() is intentionally never called here since
// claude: this process is meant to run for months, not exit after one job.
