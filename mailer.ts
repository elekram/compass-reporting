import nodemailer from 'nodemailer'
import mailConfig, { MailSecurity } from './config/mail-config.ts'
import { log, logError } from './logger.ts'

// nodemailer replaced denomailer, whose STARTTLS could never work on Deno 2:
// before upgrading it cancels/closes the connection's streams, which closes
// the socket, so Deno.startTls failed with "BadResource: Bad resource ID" —
// leaving port 587 (and so Microsoft 365, which has no 465) unusable. Moving
// also dropped two denomailer workarounds: hand-built base64 bodies (its
// quoted-printable escapes were lowercase, which Gmail refused to decode)
// and scraping its debug console output to read the server's acceptance
// line, which nodemailer returns directly.

// see mail-config.ts's MailSecurity for what each mode means.
//   tls      — implicit TLS from the first byte.
//   starttls — plain connect, then STARTTLS; refuses to continue if the
//              server doesn't offer it (requireTLS).
//   none     — STARTTLS if the server offers it, unencrypted otherwise
//              (nodemailer's default for a non-secure connection).
function securityOptions(security: MailSecurity) {
  switch (security) {
    case 'tls':
      return { secure: true }
    case 'starttls':
      return { secure: false, requireTLS: true }
    case 'none':
      return { secure: false }
  }
}

export async function sendMail(
  { to, subject, html }: { to: string | string[]; subject: string; html: string },
) {
  const recipients = Array.isArray(to) ? to : [to]
  const transport = nodemailer.createTransport({
    host: mailConfig.host,
    port: mailConfig.port,
    ...securityOptions(mailConfig.security),
    auth: mailConfig.auth
      ? { user: mailConfig.auth.username, pass: mailConfig.auth.password }
      : undefined,
  })

  try {
    const info = await transport.sendMail({
      from: mailConfig.from,
      to: recipients,
      subject,
      html,
    })

    // info.response is the server's end-of-DATA reply — for Gmail "250 2.0.0
    // OK <queue-id> - gsmtp", proof the message was accepted for delivery and
    // the id to search on in the Google Admin console.
    log(
      `mailer.ts: ${info.response} — "${subject}" accepted by ${mailConfig.host} for ${
        info.accepted.join(', ')
      }`,
    )

    // nodemailer still sends to the recipients the server accepts when it
    // refuses others, so one mistyped address doesn't stop a report reaching
    // everyone else — but the refusal is logged as an error to be fixed.
    if (info.rejected.length > 0) {
      logError(
        `mailer.ts: ${mailConfig.host} refused "${subject}" for ${
          info.rejected.join(', ')
        }`,
      )
    }
  } catch (error) {
    // nodemailer's errors carry the server's own reply (e.g. "Invalid login:
    // 535 5.7.139 Authentication unsuccessful …"), so a refused login,
    // recipient or message says why here rather than surfacing as a generic
    // send failure.
    logError(`mailer.ts: SMTP rejected "${subject}" for ${recipients.join(', ')}`, error)
    throw error
  } finally {
    transport.close()
  }
}
