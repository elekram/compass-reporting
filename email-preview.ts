import sql from './db.ts'
import config from './config/config.ts'
import { getAttendanceReportData } from './attendance-data.ts'
import emailTemplate from './email-templates/email-template.ts'

const period = Deno.args.includes('year') ? config.year : config.getCurrentTerm()
const data = await getAttendanceReportData(period)

const html = emailTemplate(data)
await Deno.writeTextFile('email-templates/email-template.html', html)
console.log('wrote email-templates/email-template.html')

await sql.end()
