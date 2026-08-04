import sql from './db.ts'
import config from './config/config.ts'
import { buildFullReportData, getStudentAttendance } from './attendance-data.ts'
import reports, { getReport } from './reports/registry.ts'
import emailTemplate from './email-templates/email-template.ts'

const args = Deno.args.filter((arg) => arg !== '--')
const reportId = args[0] ?? reports[0].id
const def = getReport(reportId)

const [yearDataset, termDataset] = await Promise.all([
  getStudentAttendance(config.year),
  getStudentAttendance(config.getCurrentTerm()),
])
const data = await buildFullReportData(yearDataset, termDataset, def)

const html = emailTemplate(data)
const outFile = `email-templates/preview-${def.id}.html`
await Deno.writeTextFile(outFile, html)
console.log(`wrote ${outFile}`)

await sql.end()
