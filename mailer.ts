import { encodeBase64 } from '@std/encoding/base64'
import { SMTPClient } from 'denomailer'
import mailConfig from './config/mail-config.ts'

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

export async function sendMail(
  { to, subject, html }: { to: string | string[]; subject: string; html: string },
) {
  const client = new SMTPClient({
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

  await client.close()
}
