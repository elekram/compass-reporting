import reports from '../reports/registry.ts'

// the deno.env variable names for each scheduled report's on/off switch and
// recipient list — shared by cron-config.ts (which reads and validates them)
// and check-env.ts (which only needs the names, to report every missing
// switch at once). Reads no env itself, so importing it never throws.
//
// names are the report id upper-cased with dashes turned to underscores,
// e.g. explained-absences-year-7 -> REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_7
// and REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_7.
export const ENABLED_PREFIX = 'REPORT_ENABLED_'
export const RECIPIENTS_PREFIX = 'REPORT_RECIPIENTS_'

// status-group-report.ts's report isn't a ReportDefinition in the registry
// (see its own comment for why), so it gets a fixed id of its own here in the
// same naming scheme.
export const STATUS_GROUP_REPORT_ID = 'status-group-breakdown'

export interface ReportEnvKeys {
  reportId: string
  enabledKey: string
  recipientsKey: string
}

function keysFor(reportId: string): ReportEnvKeys {
  const suffix = reportId.toUpperCase().replaceAll('-', '_')
  return {
    reportId,
    enabledKey: `${ENABLED_PREFIX}${suffix}`,
    recipientsKey: `${RECIPIENTS_PREFIX}${suffix}`,
  }
}

// registry order, then the status-group report last — the same order
// cron.ts sends them in.
export const registryReportKeys: ReportEnvKeys[] = reports.map((def) => keysFor(def.id))
export const statusGroupReportKeys: ReportEnvKeys = keysFor(STATUS_GROUP_REPORT_ID)
export const allReportKeys: ReportEnvKeys[] = [
  ...registryReportKeys,
  statusGroupReportKeys,
]
