import { encodeBase64 } from '@std/encoding/base64'
import { SMTPClient } from 'denomailer'
import mailConfig from './config/mail-config.ts'
import { log, logError } from './logger.ts'

// claude: denomailer's built-in quoted-printable encoder emits lowercase hex escapes
// claude: (e.g. "=3d" instead of the RFC 2045-mandated "=3D"), which Gmail's strict
// claude: decoder refuses to decode — it was rendering the raw encoded text, "=20" and
// claude: all, instead of the actual HTML. Base64-encoding the body ourselves and
// claude: passing it as a pre-built mimeContent part sidesteps that encoder entirely.
function toBase64Mime(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const base64 = encodeBase64(bytes)
  return base64.match(/.{1,76}/g)!.join('\r\n')
}

// claude: denomailer throws the server's end-of-DATA response away — client/basic/
// claude: client.ts asserts the 250 and discards the parsed Command — so the only way
// claude: to surface Gmail's "250 2.0.0 OK <queue-id> - gsmtp" acknowledgement (proof
// claude: the message was accepted for delivery, and the id to search on in the Google
// claude: Admin console) is to switch its debug logging on and read the transcript back.
// claude: Safe to do here because of how denomailer splits its output: readCmd() sends
// claude: *server responses* to console.log, while writeCmd() sends everything we
// claude: transmit — the base64 AUTH LOGIN credentials and the whole base64 message
// claude: body included — to console.table. So capturing console.log gets the response
// claude: codes and nothing else, and console.table is swallowed outright rather than
// claude: dumping the mail body and password to stdout. Anything console.logged that
// claude: isn't a "<code> ..." SMTP response line (denomailer's constructor also
// claude: narrates ".connection", ".pool" and so on) is dropped for the same reason.
const SMTP_RESPONSE_LINE = /^\d{3}[ -]/

async function captureSmtpResponses(
  exchange: () => Promise<void>,
): Promise<string[]> {
  const responses: string[] = []
  const realLog = console.log
  const realTable = console.table

  console.log = (...args: unknown[]) => {
    if (
      args.length === 1 && typeof args[0] === 'string' &&
      SMTP_RESPONSE_LINE.test(args[0])
    ) {
      responses.push(args[0])
    }
  }
  console.table = () => {}

  try {
    await exchange()
  } finally {
    console.log = realLog
    console.table = realTable
  }

  return responses
}

// claude: the transcript runs 250 (MAIL FROM) → 250 per RCPT TO → 354 (DATA) → the
// claude: acceptance line → 250 (denomailer's trailing NOOP). The line immediately
// claude: after the 354 is the one that means "queued for delivery"; anchoring on 354
// claude: rather than "last 250" keeps it from picking up that NOOP instead.
function acceptanceResponse(responses: string[]): string | null {
  const dataIndex = responses.findIndex((line) => line.startsWith('354'))
  if (dataIndex === -1) {
    return null
  }
  return responses[dataIndex + 1] ?? null
}

export async function sendMail(
  { to, subject, html }: { to: string | string[]; subject: string; html: string },
) {
  const recipients = Array.isArray(to) ? to : [to]
  let client: SMTPClient | undefined

  try {
    const responses = await captureSmtpResponses(async () => {
      // claude: constructed inside the capture too — with debug.log on, denomailer's
      // claude: constructor console.tables the resolved config, SMTP password and all,
      // claude: before a single byte goes over the wire.
      client = new SMTPClient({
        debug: { log: true },
        connection: {
          hostname: mailConfig.host,
          port: mailConfig.port,
          tls: mailConfig.secure,
          auth: {
            username: mailConfig.noReplyUserName,
            password: mailConfig.noReplyAccPassword,
          },
        },
      })

      await client.send({
        from: mailConfig.noReplyUserName,
        to,
        subject,
        mimeContent: [
          {
            mimeType: 'text/html; charset="utf-8"',
            content: toBase64Mime(html),
            transferEncoding: 'base64',
          },
        ],
      })
    })

    const acceptance = acceptanceResponse(responses)
    log(
      `mailer.ts: ${
        acceptance ?? '(no acceptance response captured)'
      } — "${subject}" accepted by ${mailConfig.host} for ${recipients.join(', ')}`,
    )
  } catch (error) {
    // claude: denomailer's assertCode throws with the offending "<code>: <args>" in the
    // claude: message, so the rejecting SMTP response ends up in this log line — a
    // claude: rejected recipient or a refused message says so here rather than just
    // claude: surfacing as a generic send failure.
    logError(
      `mailer.ts: SMTP rejected "${subject}" for ${recipients.join(', ')}`,
      error,
    )
    throw error
  } finally {
    await client?.close()
  }
}
