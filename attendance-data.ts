import sql from './db.ts'
import { personGetStudentsBasic } from './api/compass-api.ts'
import {
  assembleAttendanceReport,
  calculateAttendancePercentages,
} from './api/compass-api.helpers.ts'
import {
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentAttendancePercentage,
} from './api/compass-api.types.ts'
import { Period } from './config/config.ts'

// claude: trend windows are always relative to today, independent of whatever
// claude: report period (term/year) is being generated — a coordinator wants to
// claude: know recent momentum regardless of how far back the report itself looks.
const TREND_WINDOW_DAYS = 14

export interface AbsenceRow {
  name: string
  yearLevel: string | null
  attendancePercentage: number | null
  daysAny: number
  daysFull: number
  // claude: percentage-point change vs. the prior TREND_WINDOW_DAYS window (e.g.
  // claude: +3.2 means attendance improved 3.2 points); null if either window has
  // claude: no expected minutes for the student (e.g. new enrolment, holidays).
  trend: number | null
}

export interface AttendanceReportData {
  periodName: string
  periodStart: string
  periodEnd: string
  totalStudents: number
  unexplainedRows: AbsenceRow[]
  explainedRows: AbsenceRow[]
}

interface PeriodLineRow {
  period_line_id: string
  compass_person_id: string
  campus_guid: string | null
  description: string | null
  expected_minutes: number
  start: Date
  finish: Date
  period_code: string
  prevalent_overall_status_id: string
  standard_class_shadow: boolean | null
  teaching_time: boolean
  updated_timestamp: Date
}

interface StatusRow {
  status_id: string
  name: string
  short_code: string
  short_name: string
  description: string
  school_system_export_identifier: string
  counted_absence: boolean
  parent_selectable: boolean
  staff_selectable: boolean
}

function toAttendanceStatus(row: StatusRow): AttendanceStatus {
  return {
    __type: '',
    statusId: row.status_id,
    name: row.name,
    shortCode: row.short_code,
    shortName: row.short_name,
    description: row.description,
    schoolSystemExportIdentifier: row.school_system_export_identifier,
    countedAbsence: row.counted_absence,
    parentSelectable: row.parent_selectable,
    staffSelectable: row.staff_selectable,
  }
}

function toPeriodAttendanceLine(row: PeriodLineRow): PeriodAttendanceLine {
  return {
    __type: '',
    periodLineId: row.period_line_id,
    compassPersonId: row.compass_person_id,
    campusGuid: row.campus_guid,
    description: row.description,
    expectedMinutes: row.expected_minutes,
    start: row.start.toISOString(),
    finish: row.finish.toISOString(),
    periodCode: row.period_code,
    prevalentOverallStatusId: row.prevalent_overall_status_id,
    standardClassShadow: row.standard_class_shadow,
    teachingTime: row.teaching_time,
    updatedTimestamp: row.updated_timestamp.toISOString(),
  }
}

// claude: startIso inclusive, endExclusiveIso exclusive (so callers pass the day
// claude: after the last day they want included).
async function queryPeriodLines(
  startIso: string,
  endExclusiveIso: string,
): Promise<PeriodAttendanceLine[]> {
  const rows: PeriodLineRow[] = await sql`
    SELECT period_line_id, compass_person_id, campus_guid, description,
           expected_minutes, start, finish, period_code,
           prevalent_overall_status_id, standard_class_shadow, teaching_time,
           updated_timestamp
    FROM period_lines
    WHERE start >= ${startIso} AND start < ${endExclusiveIso}
  `
  return rows.map(toPeriodAttendanceLine)
}

function isoDateDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().substring(0, 10)
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().substring(0, 10)
}

function trendDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) {
    return null
  }
  return Math.round((current - previous) * 10) / 10
}

interface TrendPair {
  unexplainedTrend: number | null
  explainedTrend: number | null
}

// claude: compares the last TREND_WINDOW_DAYS days against the TREND_WINDOW_DAYS
// claude: before that, per student, for both absence categories. Two separate
// claude: queries (rather than one query split in JS) keeps the date-boundary
// claude: logic in SQL instead of relying on string/Date comparisons matching
// claude: exactly.
async function getTrends(
  statuses: AttendanceStatus[],
  students: Awaited<ReturnType<typeof personGetStudentsBasic>>,
): Promise<Map<string, TrendPair>> {
  const todayExclusive = addDaysIso(isoDateDaysAgo(0), 1)
  const currentStart = isoDateDaysAgo(TREND_WINDOW_DAYS)
  const previousStart = isoDateDaysAgo(TREND_WINDOW_DAYS * 2)

  const [currentLines, previousLines] = await Promise.all([
    queryPeriodLines(currentStart, todayExclusive),
    queryPeriodLines(previousStart, currentStart),
  ])

  const currentPct = calculateAttendancePercentages(
    assembleAttendanceReport(currentLines, statuses, students),
  )
  const previousPct = calculateAttendancePercentages(
    assembleAttendanceReport(previousLines, statuses, students),
  )
  const previousByStudent = new Map(previousPct.map((p) => [p.compassPersonId, p]))

  const trends = new Map<string, TrendPair>()
  for (const curr of currentPct) {
    const prev = previousByStudent.get(curr.compassPersonId) ?? null
    trends.set(curr.compassPersonId, {
      unexplainedTrend: trendDelta(
        curr.attendancePercentage,
        prev?.attendancePercentage ?? null,
      ),
      explainedTrend: trendDelta(
        curr.explainedAttendancePercentage,
        prev?.explainedAttendancePercentage ?? null,
      ),
    })
  }
  return trends
}

// claude: shared by report.ts (console/CSV output) and email-preview.ts (HTML
// claude: preview generation) — both need the identical unexplained/explained
// claude: per-student lists for a period, so the DB query and aggregation logic
// claude: lives here once rather than being duplicated.
export async function getAttendanceReportData(
  period: Period,
): Promise<AttendanceReportData> {
  const today = new Date().toISOString().substring(0, 10)
  // claude: term may still be in progress — don't project attendance across days
  // claude: that haven't happened yet, so cap the upper bound at today.
  const end = today < period.end ? today : period.end

  const [statusRows, students] = await Promise.all([
    sql<StatusRow[]>`SELECT * FROM statuses`,
    personGetStudentsBasic(),
  ])
  const statuses = statusRows.map(toAttendanceStatus)

  const periodLines = await queryPeriodLines(period.start, addDaysIso(end, 1))
  const assembled = assembleAttendanceReport(periodLines, statuses, students)
  const percentages = calculateAttendancePercentages(assembled)
  const trends = await getTrends(statuses, students)

  // claude: unmatched students (no StudentBasic join — see the ~97% match rate
  // claude: caveat) are dropped here rather than shown as blank rows, since they
  // claude: aren't actionable for a coordinator without a name.
  const matched = percentages.filter((p) => p.firstName !== null)

  function toAbsenceRow(
    p: StudentAttendancePercentage,
    attendancePercentage: number | null,
    daysAny: number,
    daysFull: number,
    trend: number | null,
  ): AbsenceRow {
    return {
      name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
      yearLevel: p.yearLevel,
      attendancePercentage,
      daysAny,
      daysFull,
      trend,
    }
  }

  // claude: both sections only show the orange/red band (below the 85% green
  // claude: cutoff used in the email template's barColor) — showing every student,
  // claude: including everyone already attending fine, was too noisy in practice.
  const unexplainedRows = matched
    .filter((p) => p.attendancePercentage !== null && p.attendancePercentage < 85)
    .sort((a, b) => (a.attendancePercentage ?? 0) - (b.attendancePercentage ?? 0))
    .map((p) =>
      toAbsenceRow(
        p,
        p.attendancePercentage,
        p.unexplainedDaysAny,
        p.unexplainedDaysFull,
        trends.get(p.compassPersonId)?.unexplainedTrend ?? null,
      )
    )

  const explainedRows = matched
    .filter((p) =>
      p.explainedAttendancePercentage !== null && p.explainedAttendancePercentage < 85
    )
    .sort((a, b) =>
      (a.explainedAttendancePercentage ?? 0) - (b.explainedAttendancePercentage ?? 0)
    )
    .map((p) =>
      toAbsenceRow(
        p,
        p.explainedAttendancePercentage,
        p.explainedDaysAny,
        p.explainedDaysFull,
        trends.get(p.compassPersonId)?.explainedTrend ?? null,
      )
    )

  return {
    periodName: period.name,
    periodStart: period.start,
    periodEnd: end,
    totalStudents: percentages.length,
    unexplainedRows,
    explainedRows,
  }
}
