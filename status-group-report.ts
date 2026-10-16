import config from './config/config.ts'
import {
  getStatusGroupBreakdown,
  StatusGroupBucket,
  StatusGroupPeriodBreakdown,
  StatusGroupScope,
} from './attendance-data.ts'

// one status group's numbers across the year's terms plus Year to Date —
// the row shape stakeholder specified (see examples/status-table-layout-
// example.csv): a percentage per term, a Trend row beneath showing the
// change vs the immediately preceding term (blank for Term 1 — no prior
// term in scope, see the earlier decision not to compare across academic
// years — and blank for Year to Date), same for every status group
// including Other.
export interface StatusGroupTrendRow {
  bucketLabel: string
  // one entry per config.terms, in order — null when that term has no
  // synced lines yet (hasn't started, e.g. Term 4 while still in Term 3).
  termPercentages: (number | null)[]
  // termTrends[0] (Term 1) is always null. termTrends[i] = termPercentages[i]
  // - termPercentages[i - 1], only when both sides are present.
  termTrends: (number | null)[]
  yearToDatePercentage: number | null
}

export interface StatusGroupTable {
  // 'Whole School' or a yearLevel value, e.g. '7'.
  scopeLabel: string
  rows: StatusGroupTrendRow[]
  // Year to Date bucket breakdown for this scope, same order as rows —
  // used for the stacked bar rendered above each table.
  yearToDateBuckets: StatusGroupBucket[]
}

export interface StatusGroupReportData {
  title: string
  termNames: string[]
  wholeSchool: StatusGroupTable
  yearLevels: StatusGroupTable[]
}

function findScope(
  scopes: StatusGroupScope[],
  label: string,
): StatusGroupScope | undefined {
  return scopes.find((s) => s.label === label)
}

// zips one scope's Year to Date buckets with its per-term buckets by index
// — safe because getStatusGroupBreakdown always emits buckets in the same
// fixed order (Present, then STATUS_GROUPS, then Other) regardless of
// scope or period.
function buildTable(
  yearScope: StatusGroupScope,
  termBreakdowns: StatusGroupPeriodBreakdown[],
  pickTermScope: (breakdown: StatusGroupPeriodBreakdown) => StatusGroupScope | undefined,
): StatusGroupTable {
  const termScopes = termBreakdowns.map(pickTermScope)

  const rows: StatusGroupTrendRow[] = yearScope.buckets.map((yearBucket, i) => {
    const termPercentages = termScopes.map((scope) =>
      scope?.buckets[i]?.percentage ?? null
    )
    const termTrends = termPercentages.map((pct, idx) => {
      if (idx === 0 || pct === null) {
        return null
      }
      const prev = termPercentages[idx - 1]
      return prev === null ? null : Math.round((pct - prev) * 10) / 10
    })

    return {
      bucketLabel: yearBucket.label,
      termPercentages,
      termTrends,
      yearToDatePercentage: yearBucket.percentage,
    }
  })

  return { scopeLabel: yearScope.label, rows, yearToDateBuckets: yearScope.buckets }
}

// deliberately separate from the ReportDefinition/registry.ts machinery
// (reports/types.ts) — that machinery is built around a per-student roster
// shape (AbsenceRow rows, a threshold cutoff, dailyPeriodBreakdown) that
// this report doesn't have: it's a whole-school/per-year-level percentage
// breakdown, not a list of students. Kept as its own small pipeline (this
// file, its own email template, its own send-status-group-report.ts entry
// point) instead of bent to fit the existing shape, so none of the
// existing reports' code paths change.
export async function buildStatusGroupReportData(): Promise<StatusGroupReportData> {
  // any number of terms (config.terms comes from deno.env's TERM_n) — the
  // email template renders one column per entry in termNames.
  const [year, ...termBreakdowns] = await Promise.all([
    getStatusGroupBreakdown(config.year),
    ...config.terms.map((term) => getStatusGroupBreakdown(term)),
  ])

  const wholeSchool = buildTable(year.wholeSchool, termBreakdowns, (b) => b.wholeSchool)
  const yearLevels = year.yearLevels.map((yearScope) =>
    buildTable(
      yearScope,
      termBreakdowns,
      (b) => findScope(b.yearLevels, yearScope.label),
    )
  )

  return {
    title: 'Attendance Term by Term Breakdown',
    termNames: config.terms.map((t) => t.name),
    wholeSchool,
    yearLevels,
  }
}
