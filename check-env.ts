// deno.env preflight — imported for its side effect as the very first line
// of every entry point (cron.ts, sync.ts, send-report.ts, report.ts,
// email-preview.ts) so a missing key throws immediately, before any of that
// script's own logic runs, and reports every missing key in one shot rather
// than whichever module happens to import first throwing on just the one it
// needs (see the DISCREPANCY_ESCALATION_THRESHOLD miss that would have hit
// production on this feature's first deploy). Not imported by
// compass-query.ts — that script is explicitly outside the sync/report
// pipeline and only ever touches COMPASS_API_KEY and COMPASS_SCHOOL_URL
// (both self-checked in api/compass-api.ts), so requiring the rest here would be a needless extra
// dependency for it.
//
// Presence only, plus the one cross-key requirement below — the actual
// value validation for each variable (e.g. CRON_DEBUG_MODE must be exactly
// "true"/"false", DISCREPANCY_ESCALATION_THRESHOLD must be a non-negative
// integer, MAIL_USERNAME/MAIL_PASSWORD are optional but must be set
// together) stays with the module that owns it (config/cron-config.ts,
// config/mail-config.ts, sync.ts, db.ts, api/compass-api.ts) rather than
// being duplicated here, so there's one place that decides what "valid"
// means for each variable, not two that can drift apart.
const requiredEnvVars = [
  'DB_URL',
  'COMPASS_API_KEY',
  'COMPASS_SCHOOL_URL',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_SECURITY',
  'MAIL_FROM',
  'SYNC_SUMMARY_RECIPIENTS',
  'CRON_DEBUG_MODE',
  'DISCREPANCY_ESCALATION_THRESHOLD',
]

// CRON_DEBUG_RECIPIENTS is only required when CRON_DEBUG_MODE=true — see
// config/cron-config.ts's own check. Mirrored here rather than imported,
// since importing cron-config.ts would throw on the first missing variable
// it finds instead of letting this script report all of them at once.
if (Deno.env.get('CRON_DEBUG_MODE') === 'true') {
  requiredEnvVars.push('CRON_DEBUG_RECIPIENTS')
}

const missing = requiredEnvVars.filter((key) => !Deno.env.get(key))

if (missing.length > 0) {
  throw new Error(`deno.env is missing required variable(s): ${missing.join(', ')}`)
}

console.log(
  `check-env.ts: all ${requiredEnvVars.length} required deno.env variables are present`,
)
