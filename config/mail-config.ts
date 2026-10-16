// SMTP connection settings live in deno.env rather than as committed literals
// so the same code can send from any school's mail account. All required
// rather than defaulted, matching cron-config.ts: a half-configured copy
// should fail loudly at startup, not quietly fall back to another school's
// server or account.
function requireEnv(key: string): string {
  const value = Deno.env.get(key)
  if (!value) {
    throw new Error(`${key} is not set in deno.env`)
  }
  return value
}

const host = requireEnv('MAIL_HOST')

const portRaw = requireEnv('MAIL_PORT')
const port = Number(portRaw)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`MAIL_PORT must be a valid port number in deno.env (got "${portRaw}")`)
}

// parsed strictly, same as CRON_DEBUG_MODE — a typo like "TRUE" must not
// silently fall through to a plaintext connection. true = implicit TLS
// (typically port 465), which is what Gmail uses here: denomailer's STARTTLS
// negotiation on 587 has a known bug, so prefer implicit TLS where the
// provider offers it.
const secureRaw = requireEnv('MAIL_SECURE')
if (secureRaw !== 'true' && secureRaw !== 'false') {
  throw new Error(
    `MAIL_SECURE must be exactly "true" or "false" in deno.env (got "${secureRaw}")`,
  )
}
const secure = secureRaw === 'true'

// also used as the From address on every email this app sends.
const noReplyUserName = requireEnv('MAIL_NO_REPLY_USERNAME')
const noReplyAccPassword = requireEnv('MAIL_NO_REPLY_PASSWORD')

// who gets the sync.ts run summary/failure email (see sync.ts) — an ops
// notification, not a coordinator-facing report, so it's a single env var
// rather than a ReportDefinition.recipients entry. Required rather than
// silently skipped so a misconfigured deno.env fails loudly instead of a
// scheduled sync going unmonitored.
const syncSummaryRecipients = requireEnv('SYNC_SUMMARY_RECIPIENTS')
  .split(',')
  .map((s) => s.trim())

const emailSettings = {
  host,
  port,
  secure,
  noReplyUserName,
  noReplyAccPassword,
  syncSummaryRecipients,
}

export default emailSettings
