import sql from './db.ts'
import config from './config/config.ts'
import { getAttendanceReportData } from './attendance-data.ts'
import emailTemplate from './email-templates/email-template.ts'
import { sendMail } from './mailer.ts'

const to = Deno.args.find((arg) => arg.includes('@'))
if (!to) {
  console.error('Usage: deno task send-report -- <recipient-email> [year]')
  await sql.end()
  Deno.exit(1)
}

const period = Deno.args.includes('year') ? config.year : config.getCurrentTerm()
const data = await getAttendanceReportData(period)

const html = emailTemplate(data)
await sendMail({ to, subject: `Attendance Report — ${data.periodName}`, html })
console.log(`Sent attendance report for ${data.periodName} to ${to}`)

await sql.end()
