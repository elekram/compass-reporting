import sql from './db.ts'
import config from './config/config.ts'
import { buildReportData, getStudentAttendance } from './attendance-data.ts'
import reports, { getReport } from './reports/registry.ts'
import emailTemplate from './email-templates/email-template.ts'

const args = Deno.args.filter((arg) => arg !== '--')
const reportId = args.find((arg) => arg !== 'year') ?? reports[0].id
const def = getReport(reportId)

const period = args.includes('year') ? config.year : config.getCurrentTerm()
const dataset = await getStudentAttendance(period)
const data = buildReportData(dataset, def)

const html = emailTemplate(data)
const outFile = `email-templates/preview-${def.id}.html`
await Deno.writeTextFile(outFile, html)
console.log(`wrote ${outFile}`)

await sql.end()
