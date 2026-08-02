import sql from './db.ts'
import config from './config/config.ts'
import { buildFullReportData, getStudentAttendance } from './attendance-data.ts'
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
const data = await buildFullReportData(dataset, def)

// claude: subject format per stakeholder request: "[Absences]Year 12 Fri 31-07-26".
// claude: falls back to the report title when there's no single year level or no
// claude: daily breakdown date to anchor the subject to (e.g. whole-school reports).
function subjectLine(): string {
  const yearLabel = def.yearLevels?.length === 1 ? `Year ${def.yearLevels[0]}` : def.title
  if (!data.dailyBreakdown) return `[Absences] ${yearLabel}`
  const [y, m, d] = data.dailyBreakdown.date.split('-')
  const weekday = new Date(`${data.dailyBreakdown.date}T00:00:00Z`).toLocaleDateString(
    'en-US',
    {
      weekday: 'short',
      timeZone: 'UTC',
    },
  )
  return `[Absences] ${yearLabel} ${weekday} ${d}-${m}-${y.slice(2)}`
}

const html = emailTemplate(data)
const subject = subjectLine()
await sendMail({ to, subject, html })
console.log(`Sent "${subject}" to ${to.join(', ')}`)

await sql.end()
