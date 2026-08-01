import sql from './db.ts'
import config from './config/config.ts'
import { buildReportData, getStudentAttendance } from './attendance-data.ts'
import reports, { getReport } from './reports/registry.ts'
import emailTemplate from './email-templates/email-template.ts'
import { sendMail } from './mailer.ts'

const args = Deno.args.filter((arg) => arg !== '--')
const cliRecipients = args.filter((arg) => arg.includes('@'))
const reportId = args.find((arg) => arg !== 'year' && !arg.includes('@'))

if (!reportId) {
  console.error('Usage: deno task send-report -- <report-id> [recipient-email...] [year]')
  console.error(`Available reports: ${reports.map((r) => r.id).join(', ')}`)
  await sql.end()
  Deno.exit(1)
}

const def = getReport(reportId)
// claude: CLI-passed emails override the report's default recipients — lets you
// claude: test a report against yourself without touching its definition.
const to = cliRecipients.length > 0 ? cliRecipients : def.recipients

if (!to || to.length === 0) {
  console.error(
    `No recipients: pass at least one email, or set default "recipients" on the "${reportId}" report definition.`,
  )
  await sql.end()
  Deno.exit(1)
}

const period = args.includes('year') ? config.year : config.getCurrentTerm()
const dataset = await getStudentAttendance(period)
const data = buildReportData(dataset, def)

const html = emailTemplate(data)
await sendMail({ to, subject: `${def.title} — ${data.periodName}`, html })
console.log(`Sent "${def.title}" for ${data.periodName} to ${to.join(', ')}`)

await sql.end()
