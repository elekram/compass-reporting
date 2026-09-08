import config from './config/config.ts'
import { LATE_ARRIVAL_LABELS } from './api/compass-api.helpers.ts'
import { getLateArrivalCounts, LateArrivalCounts } from './attendance-data.ts'

export interface LateArrivalRow {
  name: string
  studentCode: string | null
  term: LateArrivalCounts
  year: LateArrivalCounts
}

export interface LateArrivalReportData {
  title: string
  yearLevel: string
  termName: string
  rows: LateArrivalRow[]
}

const ZERO_COUNTS: LateArrivalCounts = {
  counts: LATE_ARRIVAL_LABELS.map(() => 0),
  total: 0,
}

// deliberately separate from the ReportDefinition/registry.ts machinery
// (reports/types.ts) — that machinery is threshold/percentage shaped, built
// around AbsenceRow. This report has neither: it's a raw per-student count
// of late-arrival codes, one year level per report, sorted by Year to Date
// total. Kept as its own small pipeline (this file, its own email template,
// its own send-late-arrivals-report.ts entry point) instead of bent to fit
// the existing shape, so none of the existing reports' code paths change.
export async function buildLateArrivalReportData(
  yearLevel: string,
  title: string,
): Promise<LateArrivalReportData> {
  const [yearBreakdown, termBreakdown] = await Promise.all([
    getLateArrivalCounts(config.year, yearLevel),
    getLateArrivalCounts(config.getCurrentTerm(), yearLevel),
  ])

  const termByStudent = new Map(
    termBreakdown.students.map((s) => [s.compassPersonId, s]),
  )

  // a student with zero YTD lates is excluded entirely — showing every
  // student in a year level (most with nothing to report) would bury the
  // ones actually worth a coordinator's attention.
  const rows: LateArrivalRow[] = yearBreakdown.students
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((s) => {
      const term = termByStudent.get(s.compassPersonId)
      return {
        name: s.name,
        studentCode: s.studentCode,
        year: { counts: s.counts, total: s.total },
        term: term ? { counts: term.counts, total: term.total } : ZERO_COUNTS,
      }
    })

  return {
    title,
    yearLevel,
    termName: config.getCurrentTerm().name,
    rows,
  }
}
