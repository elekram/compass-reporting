// SMTP connection settings live in deno.env rather than as committed literals
// so the same code can send from any school's mail server. Host, port,
// security mode and From address are required rather than defaulted,
// matching cron-config.ts: a half-configured copy should fail loudly at
// startup, not quietly fall back to another school's server or account.
// The login is the one optional part — plenty of internal relays accept mail
// from known hosts without one.
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

// three modes rather than a true/false flag, because denomailer refuses to
// talk to a server over an unencrypted connection at all — even with no login
// — unless explicitly told to allow it:
//   tls      — implicit TLS from the first byte (typically port 465). Gmail
//              uses this here: denomailer's STARTTLS negotiation on 587 has a
//              known bug, so prefer it where the provider offers it.
//   starttls — plain connect, then upgrade via STARTTLS (typically 587 or
//              25). Fails if the server doesn't offer STARTTLS.
//   none     — no encryption required (typically an internal relay on port
//              25). STARTTLS is still used if the server happens to offer it.
// parsed strictly, same as CRON_DEBUG_MODE — a typo must not silently fall
// through to an unencrypted connection.
export type MailSecurity = 'tls' | 'starttls' | 'none'
const MAIL_SECURITY_MODES: MailSecurity[] = ['tls', 'starttls', 'none']

const securityRaw = requireEnv('MAIL_SECURITY')
if (!MAIL_SECURITY_MODES.includes(securityRaw as MailSecurity)) {
  throw new Error(
    `MAIL_SECURITY must be one of ${
      MAIL_SECURITY_MODES.join(', ')
    } in deno.env (got "${securityRaw}")`,
  )
}
const security = securityRaw as MailSecurity

const from = requireEnv('MAIL_FROM')

// both or neither — one without the other is always a misconfiguration, and
// silently sending unauthenticated would just turn it into a confusing
// relay-denied error from the server instead.
const username = Deno.env.get('MAIL_USERNAME') || null
const password = Deno.env.get('MAIL_PASSWORD') || null
if ((username === null) !== (password === null)) {
  throw new Error(
    'MAIL_USERNAME and MAIL_PASSWORD must be set together in deno.env (or both left out for a server that needs no login)',
  )
}
const auth = username !== null && password !== null ? { username, password } : null

// with security "none" a server that doesn't offer STARTTLS would receive the
// login in plain text — refused outright rather than allowed with a warning.
if (auth && security === 'none') {
  throw new Error(
    'MAIL_SECURITY=none cannot be combined with MAIL_USERNAME/MAIL_PASSWORD — the login could be sent unencrypted. Use tls or starttls, or remove the login.',
  )
}

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
  security,
  from,
  auth,
  syncSummaryRecipients,
}

export default emailSettings
