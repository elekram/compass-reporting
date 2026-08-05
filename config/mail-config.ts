const noReplyAccPassword = Deno.env.get('MAIL_NO_REPLY_PASSWORD')
if (!noReplyAccPassword) {
  throw new Error('MAIL_NO_REPLY_PASSWORD is not set in deno.env')
}

// claude: who gets the sync.ts run summary/failure email (see sync.ts) — an ops
// claude: notification, not a coordinator-facing report, so it's a single env var
// claude: rather than a ReportDefinition.recipients entry. Required rather than
// claude: silently skipped so a misconfigured deno.env fails loudly instead of a
// claude: scheduled sync going unmonitored.
const syncSummaryRecipientsRaw = Deno.env.get('SYNC_SUMMARY_RECIPIENTS')
if (!syncSummaryRecipientsRaw) {
  throw new Error('SYNC_SUMMARY_RECIPIENTS is not set in deno.env')
}
const syncSummaryRecipients = syncSummaryRecipientsRaw.split(',').map((s) => s.trim())

const emailSettings = {
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // implicit TLS — denomailer's STARTTLS negotiation on 587 has a known bug
  noReplyUserName: 'noreply@cheltsec.vic.edu.au',
  noReplyAccPassword,
  syncSummaryRecipients,
}

export default emailSettings
