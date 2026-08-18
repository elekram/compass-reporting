import './check-env.ts'
import sql from './db.ts'
import config from './config/config.ts'
import {
  buildFullReportData,
  buildSubjectLine,
  getStudentAttendance,
} from './attendance-data.ts'
import reports, { getReport } from './reports/registry.ts'
import emailTemplate from './email-templates/email-template.ts'
import { sendMail } from './mailer.ts'

const args = Deno.args.filter((arg) => arg !== '--')
const cliRecipients = args.filter((arg) => arg.includes('@'))
const reportId = args.find((arg) => !arg.includes('@'))

if (!reportId) {
  console.error('Usage: deno task send-report -- <report-id> [recipient-email...]')
  console.error(`Available reports: ${reports.map((r) => r.id).join(', ')}`)
  await sql.end()
  Deno.exit(1)
}

const def = getReport(reportId)
// CLI-passed emails override the report's default recipients — lets you
// test a report against yourself without touching its definition.
const to = cliRecipients.length > 0 ? cliRecipients : def.recipients

if (!to || to.length === 0) {
  console.error(
    `No recipients: pass at least one email, or set default "recipients" on the "${reportId}" report definition.`,
  )
  await sql.end()
  Deno.exit(1)
}

// report rows always carry both a year and a term figure per student now
// (see AbsenceRow), so both datasets are fetched unconditionally rather
// than choosing one via a CLI arg.
const [yearDataset, termDataset] = await Promise.all([
  getStudentAttendance(config.year),
  getStudentAttendance(config.getCurrentTerm()),
])
const data = await buildFullReportData(yearDataset, termDataset, def)

const html = emailTemplate(data)
// shared with cron.ts — see buildSubjectLine in attendance-data.ts.
const subject = buildSubjectLine(def, data)
await sendMail({ to, subject, html })
console.log(`Sent "${subject}" to ${to.join(', ')}`)

await sql.end()
