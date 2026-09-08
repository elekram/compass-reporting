import './check-env.ts'
import sql from './db.ts'
import { buildLateArrivalReportData } from './late-arrivals-report.ts'
import lateArrivalsEmailTemplate from './email-templates/late-arrivals-email-template.ts'
import { sendMail } from './mailer.ts'

// standalone entry point for this report rather than folding it into
// send-report.ts/reports/registry.ts — see late-arrivals-report.ts's own
// comment for why its data shape doesn't fit that machinery.
//
// Usage:
//   deno task send-late-arrivals-report -- <yearLevel> <recipient-email...>
//   deno task send-late-arrivals-report -- <yearLevel> --preview
const args = Deno.args.filter((arg) => arg !== '--')
const yearLevel = args[0]
const rest = args.slice(1)
const preview = rest.includes('--preview')
const to = rest.filter((arg) => arg.includes('@'))

if (!yearLevel || (!preview && to.length === 0)) {
  console.error(
    'Usage: deno task send-late-arrivals-report -- <yearLevel> <recipient-email...>',
  )
  console.error('       deno task send-late-arrivals-report -- <yearLevel> --preview')
  await sql.end()
  Deno.exit(1)
}

const data = await buildLateArrivalReportData(yearLevel, `[Lates] Year ${yearLevel}`)
const html = lateArrivalsEmailTemplate(data)

if (preview) {
  const outFile = `email-templates/preview-late-arrivals-year-${yearLevel}.html`
  await Deno.writeTextFile(outFile, html)
  console.log(`wrote ${outFile}`)
} else {
  await sendMail({ to, subject: data.title, html })
  console.log(`Sent "${data.title}" to ${to.join(', ')}`)
}

await sql.end()
