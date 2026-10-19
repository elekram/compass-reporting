import './check-env.ts'
import sql from './db.ts'
import { buildStatusGroupReportData } from './status-group-report.ts'
import statusGroupEmailTemplate from './email-templates/status-group-email-template.ts'
import { sendMail } from './mailer.ts'

// standalone entry point for this one report rather than folding it into
// send-report.ts/reports/registry.ts — see status-group-report.ts's own
// comment for why its data shape doesn't fit that machinery.
//
// Usage:
//   ./run.sh send-status-group-report <recipient-email...>
//   ./run.sh send-status-group-report --preview
const args = Deno.args.filter((arg) => arg !== '--')
const preview = args.includes('--preview')
const to = args.filter((arg) => arg.includes('@'))

if (!preview && to.length === 0) {
  console.error(
    'Usage: ./run.sh send-status-group-report <recipient-email...>',
  )
  console.error('       ./run.sh send-status-group-report --preview')
  await sql.end()
  Deno.exit(1)
}

const data = await buildStatusGroupReportData()
const html = statusGroupEmailTemplate(data)

if (preview) {
  const outFile = 'email-templates/preview-status-group-breakdown.html'
  await Deno.writeTextFile(outFile, html)
  console.log(`wrote ${outFile}`)
} else {
  await sendMail({ to, subject: `[Compass] ${data.title}`, html })
  console.log(`Sent "${data.title}" to ${to.join(', ')}`)
}

await sql.end()
