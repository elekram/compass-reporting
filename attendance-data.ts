import sql from './db.ts'
import { personGetStudentsBasic } from './api/compass-api.ts'
import {
  assembleAttendanceReport,
  calculateAttendancePercentages,
  PRESENT_STATUS_EXPORT_ID,
  REPORTABLE_STATUS_EXPORT_IDS,
  UNEXPLAINED_STATUS_EXPORT_ID,
} from './api/compass-api.helpers.ts'
import {
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentAttendancePercentage,
  StudentBasic,
} from './api/compass-api.types.ts'
import { Period } from './config/config.ts'
import { ReportDefinition } from './reports/types.ts'

// claude: trend windows are always relative to today, independent of whatever
// claude: report period (term/year) is being generated — a coordinator wants to
// claude: know recent momentum regardless of how far back the report itself looks.
const TREND_WINDOW_DAYS = 14

// claude: default row-inclusion cutoff on attendance %, used unless a
// claude: ReportDefinition overrides it — also the band edge the email template
// claude: colours green/orange/red around.
const DEFAULT_THRESHOLD = 85

export interface AbsenceRow {
  name: string
  studentCode: string | null
  yearLevel: string | null
  attendancePercentage: number | null
  daysAny: number
  daysFull: number
  // claude: percentage-point change vs. the prior TREND_WINDOW_DAYS window (e.g.
  // claude: +3.2 means attendance improved 3.2 points); null if either window has
  // claude: no expected minutes for the student (e.g. new enrolment, holidays).
  trend: number | null
  // claude: period-line counts per STATUS_GROUPS (compass-api.helpers.ts), same
  // claude: order — not category-specific, unlike the fields above.
  statusGroupCounts: number[]
}

// claude: 'missing' = no period line recorded at all for that period that day
// claude: (rendered "N/A"), distinct from a recorded code that just isn't flagged.
export type DailyCellKind = 'present' | 'flagged' | 'other' | 'missing'

export interface DailyPeriodCell {
  code: string | null
  kind: DailyCellKind
}

export interface DailyBreakdownRow {
  name: string
  studentCode: string | null
  cells: DailyPeriodCell[]
}

// claude: null when the owning ReportDefinition didn't opt in (dailyPeriodBreakdown
// claude: unset) or no complete day was found yet to report on.
export interface DailyBreakdownData {
  date: string
  rows: DailyBreakdownRow[]
}

// claude: single-section report data — one category (unexplained/explained), one
// claude: ReportDefinition. Multiple reports over the same period are built by
// claude: calling buildReportData once per definition, not by branching this shape.
export interface AttendanceReportData {
  title: string
  periodName: string
  periodStart: string
  periodEnd: string
  totalStudents: number
  rows: AbsenceRow[]
  dailyBreakdown: DailyBreakdownData | null
}

interface CategoryMetrics {
  percentage: number | null
  daysAny: number
  daysFull: number
  trend: number | null
}

// claude: raw per-student numbers for a period, both categories, before any
// claude: report-specific filtering/sorting/threshold is applied. Shared base that
// claude: every ReportDefinition's buildReportData call is derived from, so adding
// claude: a new report never means re-querying or re-deriving this.
export interface StudentAttendance {
  compassPersonId: string
  name: string
  studentCode: string | null
  yearLevel: string | null
  unexplained: CategoryMetrics
  explained: CategoryMetrics
  statusGroupCounts: number[]
}

export interface AttendanceDataset {
  periodName: string
  periodStart: string
  periodEnd: string
  totalStudents: number
  students: StudentAttendance[]
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

// claude: the 6 numbered teaching periods a school day is built from — excludes
// claude: non-teaching blocks (AS/BS/L1/L2/R), which don't fit a fixed 6-column
// claude: layout and aren't what "6 periods of the day" refers to.
const TEACHING_PERIOD_CODES = ['1', '2', '3', '4', '5', '6']

// claude: a day only counts as "complete" once roughly the whole school has synced
// claude: rolls for it — the most recent day in period_lines is often still being
// claude: marked in Compass and syncs with a small fraction of students (e.g. 48 of
// claude: ~686), which would make the breakdown table look broken for everyone else.
// claude: 300 is comfortably below every normal day's headcount (600+) and well
// claude: above a partially-synced one.
const MIN_STUDENTS_FOR_COMPLETE_DAY = 300

// claude: school timezone — `start` is stored as timestamptz (UTC instants), but
// claude: Melbourne is UTC+10/+11, so morning periods (e.g. period 1 at 08:50 local)
// claude: land on the *previous* UTC calendar date. Grouping/filtering by a raw
// claude: `start::date` (as this used to) splits a single local school day across
// claude: two UTC dates — Postgres's `AT TIME ZONE` handles the DST-aware
// claude: conversion correctly, so all local-day logic goes through it rather than
// claude: JS Date arithmetic.
const SCHOOL_TIMEZONE = 'Australia/Melbourne'

async function findMostRecentCompleteDay(): Promise<string | null> {
  const [row] = await sql<[{ day: Date }?]>`
    SELECT (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date AS day
    FROM period_lines
    WHERE (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date < (now() AT TIME ZONE ${SCHOOL_TIMEZONE})::date
    GROUP BY day
    HAVING COUNT(DISTINCT compass_person_id) >= ${MIN_STUDENTS_FOR_COMPLETE_DAY}
    ORDER BY day DESC
    LIMIT 1
  `
  return row ? row.day.toISOString().substring(0, 10) : null
}

// claude: fetches every period line whose local (SCHOOL_TIMEZONE) calendar date
// claude: matches dateIso — see the SCHOOL_TIMEZONE comment for why this can't just
// claude: be a UTC start/end range like queryPeriodLines.
async function queryPeriodLinesForLocalDay(
  dateIso: string,
): Promise<PeriodAttendanceLine[]> {
  const rows: PeriodLineRow[] = await sql`
    SELECT period_line_id, compass_person_id, campus_guid, description,
           expected_minutes, start, finish, period_code,
           prevalent_overall_status_id, standard_class_shadow, teaching_time,
           updated_timestamp
    FROM period_lines
    WHERE (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date = ${dateIso}
  `
  return rows.map(toPeriodAttendanceLine)
}

function classifyDailyCode(code: string | null): DailyCellKind {
  if (code === null) {
    return 'missing'
  }
  if (code === PRESENT_STATUS_EXPORT_ID) {
    return 'present'
  }
  if (REPORTABLE_STATUS_EXPORT_IDS.has(code)) {
    return 'flagged'
  }
  return 'other'
}

// claude: builds the extra table (opt-in via ReportDefinition.dailyPeriodBreakdown)
// claude: showing, for the most recent complete school day, one row per student (in
// claude: this report's category/yearLevels scope) who had at least one flagged
// claude: period that day, with one column per teaching period. Separate from
// claude: getStudentAttendance/buildReportData since it's day-scoped rather than
// claude: term-scoped and needs its own period_lines query.
export async function getDailyPeriodBreakdown(
  def: ReportDefinition,
): Promise<DailyBreakdownData | null> {
  if (!def.dailyPeriodBreakdown) {
    return null
  }

  const day = await findMostRecentCompleteDay()
  if (!day) {
    return null
  }

  const [statusRows, students, lines]: [
    StatusRow[],
    StudentBasic[],
    PeriodAttendanceLine[],
  ] = await Promise.all([
    sql<StatusRow[]>`SELECT * FROM statuses`,
    personGetStudentsBasic(),
    queryPeriodLinesForLocalDay(day),
  ])

  const statusById = new Map(statusRows.map((s) => [s.status_id, s]))
  const studentById = new Map(students.map((s) => [s.compassPersonId, s]))

  const teachingLines = lines.filter((line) =>
    line.teachingTime && TEACHING_PERIOD_CODES.includes(line.periodCode)
  )

  const linesByStudent = new Map<string, PeriodAttendanceLine[]>()
  for (const line of teachingLines) {
    if (!linesByStudent.has(line.compassPersonId)) {
      linesByStudent.set(line.compassPersonId, [])
    }
    linesByStudent.get(line.compassPersonId)!.push(line)
  }

  // claude: "flagged" scoped to the report's own category — explained reports only
  // claude: pull a student in for an explained code, unexplained reports only for
  // claude: the unexplained one — same split calculateAttendancePercentages uses.
  const inclusionIds = def.category === 'unexplained'
    ? new Set([UNEXPLAINED_STATUS_EXPORT_ID])
    : new Set(
      [...REPORTABLE_STATUS_EXPORT_IDS].filter((id) =>
        id !== UNEXPLAINED_STATUS_EXPORT_ID
      ),
    )

  const rows: DailyBreakdownRow[] = []
  for (const [compassPersonId, studentLines] of linesByStudent) {
    const student = studentById.get(compassPersonId)
    if (!student) {
      continue
    }
    if (def.yearLevels && !def.yearLevels.includes(student.yearLevel)) {
      continue
    }

    const linesByPeriod = new Map(studentLines.map((line) => [line.periodCode, line]))
    const codes = TEACHING_PERIOD_CODES.map((periodCode) => {
      const line = linesByPeriod.get(periodCode)
      if (!line) {
        return null
      }
      const status = statusById.get(line.prevalentOverallStatusId)
      return status?.school_system_export_identifier ?? null
    })

    const hasFlaggedPeriod = codes.some((code) => code !== null && inclusionIds.has(code))
    if (!hasFlaggedPeriod) {
      continue
    }

    rows.push({
      name: `${student.firstName} ${student.lastName}`.trim(),
      studentCode: student.studentCode,
      cells: codes.map((code) => ({ code, kind: classifyDailyCode(code) })),
    })
  }

  rows.sort((a, b) => a.name.localeCompare(b.name))

  return { date: day, rows }
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

function toStudentAttendance(
  p: StudentAttendancePercentage,
  trend: TrendPair | undefined,
): StudentAttendance {
  return {
    compassPersonId: p.compassPersonId,
    name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    studentCode: p.studentCode,
    yearLevel: p.yearLevel,
    unexplained: {
      percentage: p.attendancePercentage,
      daysAny: p.unexplainedDaysAny,
      daysFull: p.unexplainedDaysFull,
      trend: trend?.unexplainedTrend ?? null,
    },
    explained: {
      percentage: p.explainedAttendancePercentage,
      daysAny: p.explainedDaysAny,
      daysFull: p.explainedDaysFull,
      trend: trend?.explainedTrend ?? null,
    },
    statusGroupCounts: p.statusGroupCounts,
  }
}

// claude: the single DB-fetching entry point — every report, however it's sliced
// claude: (category/year level/threshold), is derived from this same dataset via
// claude: buildReportData rather than re-querying period_lines per report.
export async function getStudentAttendance(period: Period): Promise<AttendanceDataset> {
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

  return {
    periodName: period.name,
    periodStart: period.start,
    periodEnd: end,
    totalStudents: matched.length,
    students: matched.map((p) => toStudentAttendance(p, trends.get(p.compassPersonId))),
  }
}

// claude: shapes one AttendanceDataset into the single-section rows a specific
// claude: ReportDefinition wants — year-level filter, category pick, threshold
// claude: cutoff and sort all live here so reports/*.ts definitions stay pure data.
export function buildReportData(
  dataset: AttendanceDataset,
  def: ReportDefinition,
): AttendanceReportData {
  const threshold = def.threshold ?? DEFAULT_THRESHOLD
  const yearLevels = def.yearLevels

  const scoped = yearLevels
    ? dataset.students.filter((s) =>
      s.yearLevel !== null && yearLevels.includes(s.yearLevel)
    )
    : dataset.students

  const rows: AbsenceRow[] = scoped
    .filter((s) => {
      const percentage = s[def.category].percentage
      return percentage !== null && percentage < threshold
    })
    .sort((a, b) => (a[def.category].percentage ?? 0) - (b[def.category].percentage ?? 0))
    .map((s) => ({
      name: s.name,
      studentCode: s.studentCode,
      yearLevel: s.yearLevel,
      attendancePercentage: s[def.category].percentage,
      daysAny: s[def.category].daysAny,
      daysFull: s[def.category].daysFull,
      trend: s[def.category].trend,
      statusGroupCounts: s.statusGroupCounts,
    }))

  return {
    title: def.title,
    periodName: dataset.periodName,
    periodStart: dataset.periodStart,
    periodEnd: dataset.periodEnd,
    totalStudents: dataset.totalStudents,
    rows,
    dailyBreakdown: null,
  }
}

// claude: buildReportData plus the opt-in daily breakdown table — the version
// claude: send-report.ts/email-preview.ts should use, since those render the full
// claude: email. report.ts (CSV/console output) has no use for the daily table, so
// claude: it calls buildReportData directly and stays synchronous.
export async function buildFullReportData(
  dataset: AttendanceDataset,
  def: ReportDefinition,
): Promise<AttendanceReportData> {
  const data = buildReportData(dataset, def)
  const dailyBreakdown = await getDailyPeriodBreakdown(def)
  return { ...data, dailyBreakdown }
}
