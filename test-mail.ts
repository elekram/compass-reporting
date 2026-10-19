// sends one short test email through the same mailer.ts/mail-config.ts path
// every report uses, to check deno.env's MAIL_* settings without waiting for
// a scheduled run or needing any attendance data.
//
// Usage:
//   ./run.sh test-mail <recipient-email...>
//   ./run.sh test-mail           (sends to SYNC_SUMMARY_RECIPIENTS)
//
// Deliberately doesn't import check-env.ts, same as compass-query.ts: it only
// touches the mail settings (validated by mail-config.ts itself), so a dev
// copy can test mail before the rest of deno.env is filled in. Nor does it
// touch Postgres, so it can be run with `docker compose run --no-deps`.
import mailConfig from './config/mail-config.ts'
import { sendMail } from './mailer.ts'

const args = Deno.args.filter((arg) => arg !== '--')
const to = args.length > 0 ? args : mailConfig.syncSummaryRecipients

const invalid = to.filter((address) => !address.includes('@'))
if (invalid.length > 0) {
  console.error(`Not an email address: ${invalid.join(', ')}`)
  console.error('Usage: ./run.sh test-mail [recipient-email...]')
  Deno.exit(1)
}

// the settings being tested, minus the password — so a failure can be read
// against exactly what was tried.
const settings = [
  `host ${mailConfig.host}`,
  `port ${mailConfig.port}`,
  `security ${mailConfig.security}`,
  `from ${mailConfig.from}`,
  `login ${mailConfig.auth ? mailConfig.auth.username : '(none)'}`,
].join(', ')
console.log(`test-mail.ts: sending to ${to.join(', ')} via ${settings}`)

const sentAt = new Date().toISOString()
try {
  await sendMail({
    to,
    subject: '[Compass] Mail test',
    html: `
      <div style="font-family: sans-serif; font-size: 14px; color: #000;">
        <p><b>compass-reporting mail test</b></p>
        <p>If you can read this, the MAIL_* settings in deno.env work.</p>
        <p style="color: #666;">Sent ${sentAt} via ${settings}.</p>
      </div>
    `,
  })
  // mailer.ts has already logged the server's acceptance line by here.
  console.log('test-mail.ts: OK')
} catch {
  // mailer.ts has already logged the SMTP error in full.
  console.error('test-mail.ts: FAILED — see the error above')
  Deno.exit(1)
}
