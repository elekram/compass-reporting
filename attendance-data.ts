import sql from './db.ts'
import {
  assembleAttendanceReport,
  calculateAttendancePercentages,
  isFlaggedForCategory,
  isReportableAbsence,
  PRESENT_STATUS_EXPORT_ID,
  STATUS_GROUP_LABELS,
  STATUS_GROUPS,
} from './api/compass-api.helpers.ts'
import {
  AssembledAttendancePeriodLine,
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentAttendancePercentage,
  StudentRosterEntry,
} from './api/compass-api.types.ts'
import { Period } from './config/config.ts'
import {
  addDaysIso,
  lastCompleteSchoolDateIso,
  SCHOOL_TIMEZONE,
  weekdayOfDateIso,
} from './config/timezone.ts'
import { AbsenceCategory, ReportDefinition } from './reports/types.ts'

// trend windows are always relative to today, independent of whatever
// report period (term/year) is being generated — a coordinator wants to
// know recent momentum regardless of how far back the report itself looks.
const TREND_WINDOW_DAYS = 14

// default row-inclusion cutoff on attendance %, used unless a
// ReportDefinition overrides it — also the band edge the email template
// colours green/orange/red around.
const DEFAULT_THRESHOLD = 85

export interface PeriodMetrics {
  attendancePercentage: number | null
  daysAny: number
  daysFull: number
  // percentage-point change vs. the prior TREND_WINDOW_DAYS window (e.g.
  // +3.2 means attendance improved 3.2 points); null if either window has
  // no expected minutes for the student (e.g. new enrolment, holidays).
  trend: number | null
}

// one row = one qualifying student, carrying both their year-to-date and
// current-term numbers (see buildReportData) — the email template renders
// these as two sub-rows under the student's name, per stakeholder request.
export interface AbsenceRow {
  name: string
  studentCode: string | null
  yearLevel: string | null
  year: PeriodMetrics
  term: PeriodMetrics
  // period-line counts per STATUS_GROUPS (compass-api.helpers.ts), same
  // order, scoped to the *year* (not term) — a single running total shown
  // once per student rather than split per period row.
  statusGroupCounts: number[]
}

// 'missing' = no period line recorded at all for that period that day
// (rendered "N/A"), distinct from a recorded code that just isn't flagged.
export type DailyCellKind = 'present' | 'flagged' | 'other' | 'missing'

export interface DailyPeriodCell {
  code: string | null
  kind: DailyCellKind
}

export interface DailyBreakdownRow {
  name: string
  studentCode: string | null
  cells: DailyPeriodCell[]
  // consecutive fully-absent school days ending on (and including) this
  // table's date — only computed for the most recent day's table (see
  // getDailyPeriodBreakdown), 0 everywhere else so the template's ">threshold"
  // highlight check is a harmless no-op on older days.
  awayStreakDays: number
}

// "more than three days in a row" per stakeholder request — a student's
// awayStreakDays must exceed this (i.e. be 4+) to be highlighted.
export const AWAY_STREAK_HIGHLIGHT_THRESHOLD = 3

// how many school days back the streak walk is willing to look — generous
// upper bound (~8 school weeks) so a genuinely long absence isn't cut short, without
// scanning the whole dataset for students who were only away for a day or two.
const AWAY_STREAK_LOOKBACK_DAYS = 40

// null when the owning ReportDefinition didn't opt in (dailyPeriodBreakdown
// unset) or no complete day was found yet to report on.
export interface DailyBreakdownData {
  date: string
  rows: DailyBreakdownRow[]
}

// single-section report data — one category (unexplained/explained), one
// ReportDefinition. Multiple reports over the same period are built by
// calling buildReportData once per definition, not by branching this shape.
export interface AttendanceReportData {
  title: string
  periodName: string
  periodStart: string
  periodEnd: string
  totalStudents: number
  // row-inclusion cutoff this report was built with (def.threshold ??
  // DEFAULT_THRESHOLD) — carried through so the email template can state it
  // (e.g. "Below 85%") without hardcoding the default.
  threshold: number
  rows: AbsenceRow[]
  // one entry per complete day covered (see DAILY_BREAKDOWN_DAYS), most
  // recent first; empty when the report didn't opt in or no days qualified.
  dailyBreakdown: DailyBreakdownData[]
}

interface CategoryMetrics {
  percentage: number | null
  daysAny: number
  daysFull: number
  trend: number | null
}

// raw per-student numbers for a period, both categories, before any
// report-specific filtering/sorting/threshold is applied. Shared base that
// every ReportDefinition's buildReportData call is derived from, so adding
// a new report never means re-querying or re-deriving this.
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

interface StudentRow {
  compass_person_id: string
  first_name: string
  last_name: string
  student_code: string | null
  year_level: string | null
}

function toStudentRosterEntry(row: StudentRow): StudentRosterEntry {
  return {
    compassPersonId: row.compass_person_id,
    firstName: row.first_name,
    lastName: row.last_name,
    studentCode: row.student_code,
    yearLevel: row.year_level,
  }
}

// reads the roster cached by sync.ts's upsertStudents instead of making a
// live personGetStudentsBasic call — every report-generation entry point
// below uses this rather than hitting Compass directly, so a send-report run
// only ever depends on Compass being up at sync time, not at send time.
async function queryStudentRoster(): Promise<StudentRosterEntry[]> {
  const rows: StudentRow[] = await sql`
    SELECT compass_person_id, first_name, last_name, student_code, year_level
    FROM students
  `
  return rows.map(toStudentRosterEntry)
}

// the two small reference tables every report joins period lines against:
// Compass's status list and the cached student roster. Loaded once per
// dataset build (see loadAssembledLines) instead of separately by each
// report function.
interface ReferenceData {
  statuses: AttendanceStatus[]
  students: StudentRosterEntry[]
  // statusId -> status, for code lookups on raw lines (daily breakdown,
  // away streaks)
  statusById: Map<string, AttendanceStatus>
}

async function loadReferenceData(): Promise<ReferenceData> {
  const [statusRows, students]: [StatusRow[], StudentRosterEntry[]] = await Promise.all([
    sql<StatusRow[]>`SELECT * FROM statuses`,
    queryStudentRoster(),
  ])
  const statuses = statusRows.map(toAttendanceStatus)
  return {
    statuses,
    students,
    statusById: new Map(statuses.map((s) => [s.statusId, s])),
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

// a period line's school-local date, as an SQL expression — every query that
// filters or groups period_lines by day goes through this, so "which day is
// this line on" is decided the same way everywhere (see config/timezone.ts).
// `start` is a timestamptz (a UTC instant): comparing it to a plain
// 'YYYY-MM-DD' instead would read the date as UTC midnight — 10/11am in
// Melbourne — and shift every range by those hours (this used to drop
// periods 1-2 of a range's first day and pull in periods 1-2 of the day
// after its last).
function startSchoolDate() {
  return sql`(start AT TIME ZONE ${SCHOOL_TIMEZONE})::date`
}

// period lines whose school date falls within startIso..endIso, both
// inclusive. Empty when endIso < startIso (e.g. a term's first morning,
// before any of its days are complete).
async function queryPeriodLines(
  startIso: string,
  endIso: string,
): Promise<PeriodAttendanceLine[]> {
  const rows: PeriodLineRow[] = await sql`
    SELECT period_line_id, compass_person_id, campus_guid, description,
           expected_minutes, start, finish, period_code,
           prevalent_overall_status_id, standard_class_shadow, teaching_time,
           updated_timestamp
    FROM period_lines
    WHERE ${startSchoolDate()} BETWEEN ${startIso} AND ${endIso}
  `
  return rows.map(toPeriodAttendanceLine)
}

// every period line in startIso..endIso (school dates, inclusive), joined to
// its student and status — the input every percentage and status-group
// figure is calculated from, so all reports read the data the same way.
async function loadAssembledLines(
  startIso: string,
  endIso: string,
  ref: ReferenceData,
): Promise<AssembledAttendancePeriodLine[]> {
  const lines = await queryPeriodLines(startIso, endIso)
  return assembleAttendanceReport(lines, ref.statuses, ref.students)
}

// a reporting period capped at the last complete school day — reports never
// count today (see lastCompleteSchoolDateIso) or days that haven't happened.
function completedPeriodEnd(period: Period): string {
  const lastComplete = lastCompleteSchoolDateIso()
  return lastComplete < period.end ? lastComplete : period.end
}

// the 6 numbered teaching periods a school day is built from — excludes
// non-teaching blocks (AS/BS/L1/L2/R), which don't fit a fixed 6-column
// layout and aren't what "6 periods of the day" refers to.
const TEACHING_PERIOD_CODES = ['1', '2', '3', '4', '5', '6']

// a day only counts as "complete" once roughly the whole school has synced
// rolls for it — the most recent day in period_lines is often still being
// marked in Compass and syncs with a small fraction of students (e.g. 48 of
// ~686), which would make the breakdown table look broken for everyone else.
// 300 is comfortably below every normal day's headcount (600+) and well
// above a partially-synced one.
const MIN_STUDENTS_FOR_COMPLETE_DAY = 300

// most recent complete days first (descending) — the daily breakdown
// table renders them in this order, most recent day on top. "Complete" =
// on or before the last complete school day (the app's clock, via
// lastCompleteSchoolDateIso, rather than the database's now()) and with
// enough students marked. Days come back as 'YYYY-MM-DD' text straight from
// SQL, so no Date conversion is needed to read them.
async function findMostRecentCompleteDays(count: number): Promise<string[]> {
  const rows: { day: string }[] = await sql`
    SELECT ${startSchoolDate()}::text AS day
    FROM period_lines
    WHERE ${startSchoolDate()} <= ${lastCompleteSchoolDateIso()}
    GROUP BY day
    HAVING COUNT(DISTINCT compass_person_id) >= ${MIN_STUDENTS_FOR_COMPLETE_DAY}
    ORDER BY day DESC
    LIMIT ${count}
  `
  return rows.map((row) => row.day)
}

// fetches every period line on one school date (see startSchoolDate).
async function queryPeriodLinesForLocalDay(
  dateIso: string,
): Promise<PeriodAttendanceLine[]> {
  return await queryPeriodLines(dateIso, dateIso)
}

function classifyDailyCode(code: string | null): DailyCellKind {
  if (code === null) {
    return 'missing'
  }
  if (code === PRESENT_STATUS_EXPORT_ID) {
    return 'present'
  }
  if (isReportableAbsence(code)) {
    return 'flagged'
  }
  return 'other'
}

// how many of the most recent complete school days the breakdown table
// covers — per stakeholder request, was 1 (just "yesterday").
const DAILY_BREAKDOWN_DAYS = 3

interface AwayStreakLineRow {
  compass_person_id: string
  day: string
  period_code: string
  prevalent_overall_status_id: string
}

// walks backward, school day by school day, from `mostRecentDay`, counting
// how many consecutive days each candidate student was away every one of the
// 6 teaching periods that day (same "every period flagged" test the Full Days
// metric elsewhere uses) — stops at the first day that isn't a full absence,
// or at the edge of AWAY_STREAK_LOOKBACK_DAYS/available school days.
async function computeAwayStreaks(
  mostRecentDay: string,
  candidateIds: string[],
  statusById: Map<string, AttendanceStatus>,
  def: ReportDefinition,
): Promise<Map<string, number>> {
  if (candidateIds.length === 0) {
    return new Map()
  }

  const schoolDays = await findMostRecentCompleteDays(AWAY_STREAK_LOOKBACK_DAYS)
  // findMostRecentCompleteDays looks backward from "now", not from
  // mostRecentDay — in normal operation mostRecentDay is schoolDays[0], but
  // this guards against drift (e.g. a new day completing between the two
  // calls) by anchoring the walk to mostRecentDay's own position.
  const startIndex = schoolDays.indexOf(mostRecentDay)
  const walkDays = startIndex === -1 ? [] : schoolDays.slice(startIndex)
  if (walkDays.length === 0) {
    return new Map()
  }

  const rangeStart = walkDays[walkDays.length - 1]
  const rows: AwayStreakLineRow[] = await sql`
    SELECT compass_person_id, ${startSchoolDate()}::text AS day,
           period_code, prevalent_overall_status_id
    FROM period_lines
    WHERE compass_person_id = ANY(${candidateIds})
      AND teaching_time = true
      AND period_code = ANY(${TEACHING_PERIOD_CODES})
      AND ${startSchoolDate()} BETWEEN ${rangeStart} AND ${mostRecentDay}
  `

  const codesByKey = new Map<string, Map<string, string | null>>()
  for (const row of rows) {
    const dayIso = row.day
    const key = `${row.compass_person_id}|${dayIso}`
    if (!codesByKey.has(key)) {
      codesByKey.set(key, new Map())
    }
    const status = statusById.get(row.prevalent_overall_status_id)
    codesByKey.get(key)!.set(
      row.period_code,
      status?.schoolSystemExportIdentifier ?? null,
    )
  }

  function isFullyAway(studentId: string, day: string): boolean {
    const periods = codesByKey.get(`${studentId}|${day}`)
    if (!periods) {
      return false
    }
    return TEACHING_PERIOD_CODES.every((code) => {
      const exportId = periods.get(code)
      return exportId != null && isFlaggedForCategory(def.category, exportId)
    })
  }

  const streaks = new Map<string, number>()
  for (const studentId of candidateIds) {
    let streak = 0
    for (const day of walkDays) {
      if (!isFullyAway(studentId, day)) {
        break
      }
      streak++
    }
    streaks.set(studentId, streak)
  }
  return streaks
}

async function buildDailyBreakdownForDay(
  day: string,
  statusById: Map<string, AttendanceStatus>,
  studentById: Map<string, StudentRosterEntry>,
  def: ReportDefinition,
  computeAwayStreak: boolean,
): Promise<DailyBreakdownData> {
  const lines = await queryPeriodLinesForLocalDay(day)

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

  const candidates: {
    compassPersonId: string
    name: string
    studentCode: string | null
    cells: DailyPeriodCell[]
  }[] = []
  for (const [compassPersonId, studentLines] of linesByStudent) {
    const student = studentById.get(compassPersonId)
    if (!student) {
      continue
    }
    if (
      def.yearLevels &&
      (student.yearLevel === null || !def.yearLevels.includes(student.yearLevel))
    ) {
      continue
    }

    const linesByPeriod = new Map(studentLines.map((line) => [line.periodCode, line]))
    const codes = TEACHING_PERIOD_CODES.map((periodCode) => {
      const line = linesByPeriod.get(periodCode)
      if (!line) {
        return null
      }
      const status = statusById.get(line.prevalentOverallStatusId)
      return status?.schoolSystemExportIdentifier ?? null
    })

    // see isFlaggedForCategory — explained reports also surface unexplained
    // periods here, per stakeholder request.
    const hasFlaggedPeriod = codes.some((code) =>
      isFlaggedForCategory(def.category, code)
    )
    if (!hasFlaggedPeriod) {
      continue
    }

    candidates.push({
      compassPersonId,
      name: `${student.firstName} ${student.lastName}`.trim(),
      studentCode: student.studentCode,
      cells: codes.map((code) => ({ code, kind: classifyDailyCode(code) })),
    })
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name))

  const streaks = computeAwayStreak
    ? await computeAwayStreaks(
      day,
      candidates.map((c) => c.compassPersonId),
      statusById,
      def,
    )
    : new Map<string, number>()

  const rows: DailyBreakdownRow[] = candidates.map((c) => ({
    name: c.name,
    studentCode: c.studentCode,
    cells: c.cells,
    awayStreakDays: streaks.get(c.compassPersonId) ?? 0,
  }))

  return { date: day, rows }
}

// builds the extra table(s) (opt-in via ReportDefinition.dailyPeriodBreakdown)
// showing, for each of the most recent DAILY_BREAKDOWN_DAYS complete school
// days, one row per student (in this report's category/yearLevels scope) who
// had at least one flagged period that day, with one column per teaching
// period. Separate from getStudentAttendance/buildReportData since it's
// day-scoped rather than term-scoped and needs its own period_lines queries.
// days with no qualifying students are dropped (mirrors the old single-day
// behaviour of hiding the table entirely when empty).
export async function getDailyPeriodBreakdown(
  def: ReportDefinition,
): Promise<DailyBreakdownData[]> {
  if (!def.dailyPeriodBreakdown) {
    return []
  }

  const days = await findMostRecentCompleteDays(DAILY_BREAKDOWN_DAYS)
  if (days.length === 0) {
    return []
  }

  const ref = await loadReferenceData()
  const studentById = new Map(ref.students.map((s) => [s.compassPersonId, s]))

  const results = await Promise.all(
    days.map((day, index) =>
      buildDailyBreakdownForDay(day, ref.statusById, studentById, def, index === 0)
    ),
  )

  return results.filter((result) => result.rows.length > 0)
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

// compares the last TREND_WINDOW_DAYS calendar days (ending on the last
// complete school day) against the TREND_WINDOW_DAYS before that, per
// student, for both absence categories. Both windows are inclusive school
// date ranges of exactly TREND_WINDOW_DAYS days, back to back with no
// overlap.
async function getTrends(ref: ReferenceData): Promise<Map<string, TrendPair>> {
  const currentEnd = lastCompleteSchoolDateIso()
  const currentStart = addDaysIso(currentEnd, -(TREND_WINDOW_DAYS - 1))
  const previousEnd = addDaysIso(currentStart, -1)
  const previousStart = addDaysIso(previousEnd, -(TREND_WINDOW_DAYS - 1))

  const [currentLines, previousLines] = await Promise.all([
    loadAssembledLines(currentStart, currentEnd, ref),
    loadAssembledLines(previousStart, previousEnd, ref),
  ])

  const currentPct = calculateAttendancePercentages(currentLines)
  const previousPct = calculateAttendancePercentages(previousLines)
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

// the single DB-fetching entry point — every report, however it's sliced
// (category/year level/threshold), is derived from this same dataset via
// buildReportData rather than re-querying period_lines per report.
export async function getStudentAttendance(period: Period): Promise<AttendanceDataset> {
  // term may still be in progress — only count school days that are fully
  // over (see completedPeriodEnd).
  const end = completedPeriodEnd(period)

  const ref = await loadReferenceData()
  const assembled = await loadAssembledLines(period.start, end, ref)
  const percentages = calculateAttendancePercentages(assembled)
  const trends = await getTrends(ref)

  // unmatched students (no roster join — see the ~97% match rate caveat on
  // personGetStudentsBasic) are dropped here rather than shown as blank rows,
  // since they aren't actionable for a coordinator without a name.
  const matched = percentages.filter((p) => p.firstName !== null)

  return {
    periodName: period.name,
    periodStart: period.start,
    periodEnd: end,
    totalStudents: matched.length,
    students: matched.map((p) => toStudentAttendance(p, trends.get(p.compassPersonId))),
  }
}

function toPeriodMetrics(
  s: StudentAttendance | undefined,
  category: AbsenceCategory,
): PeriodMetrics {
  if (!s) {
    return { attendancePercentage: null, daysAny: 0, daysFull: 0, trend: null }
  }
  const m = s[category]
  return {
    attendancePercentage: m.percentage,
    daysAny: m.daysAny,
    daysFull: m.daysFull,
    trend: m.trend,
  }
}

// shapes a year AttendanceDataset (plus the matching term dataset for the
// term row) into the single-section rows a specific ReportDefinition wants.
// inclusion is decided on the *year* percentage only — per stakeholder
// request, a student shows up (with both their year and term rows) as soon
// as their year-to-date attendance drops below the threshold, even if their
// current term alone would look fine. Year-level filter, category pick,
// threshold cutoff and sort all live here so reports/*.ts definitions stay
// pure data.
export function buildReportData(
  yearDataset: AttendanceDataset,
  termDataset: AttendanceDataset,
  def: ReportDefinition,
): AttendanceReportData {
  const threshold = def.threshold ?? DEFAULT_THRESHOLD
  const yearLevels = def.yearLevels

  const scoped = yearLevels
    ? yearDataset.students.filter((s) =>
      s.yearLevel !== null && yearLevels.includes(s.yearLevel)
    )
    : yearDataset.students

  const termByStudent = new Map(termDataset.students.map((s) => [s.compassPersonId, s]))

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
      year: toPeriodMetrics(s, def.category),
      term: toPeriodMetrics(termByStudent.get(s.compassPersonId), def.category),
      statusGroupCounts: s.statusGroupCounts,
    }))

  return {
    title: def.title,
    periodName: yearDataset.periodName,
    periodStart: yearDataset.periodStart,
    periodEnd: yearDataset.periodEnd,
    totalStudents: yearDataset.totalStudents,
    threshold,
    rows,
    dailyBreakdown: [],
  }
}

// buildReportData plus the opt-in daily breakdown table — the version
// send-report.ts/email-preview.ts should use, since those render the full
// email. report.ts (CSV/console output) has no use for the daily table, so
// it calls buildReportData directly and stays synchronous.
export async function buildFullReportData(
  yearDataset: AttendanceDataset,
  termDataset: AttendanceDataset,
  def: ReportDefinition,
): Promise<AttendanceReportData> {
  const data = buildReportData(yearDataset, termDataset, def)
  const dailyBreakdown = await getDailyPeriodBreakdown(def)
  return { ...data, dailyBreakdown }
}

// shared by send-report.ts (manual/CLI sends) and cron.ts (scheduled sends)
// so the subject format can't drift between the two paths. Anchored to the
// most recent day in the daily breakdown (not "today") — see
// findMostRecentCompleteDays — falls back to just the report label when
// there's no daily breakdown (e.g. whole-school reports, which don't opt in).
export function buildSubjectLine(
  def: ReportDefinition,
  data: AttendanceReportData,
): string {
  const yearLabel = def.yearLevels?.length === 1 ? `Year ${def.yearLevels[0]}` : def.title
  const mostRecentDay = data.dailyBreakdown[0]
  if (!mostRecentDay) {
    return `[Absences] ${yearLabel}`
  }
  const [y, m, d] = mostRecentDay.date.split('-')
  const weekday = weekdayOfDateIso(mostRecentDay.date, 'short')
  return `[Absences] ${yearLabel} ${weekday} ${d}/${m}/${y}`
}

// ---- status-group percentage breakdown ----
// Built for the principal-facing "attendance status breakdown" report
// (status-group-report.ts) — a wholly separate data shape from
// AttendanceDataset/AbsenceRow above (whole-school and per-year-level
// percentages, not a per-student roster), so it does its own DB fetch here
// rather than being derived from getStudentAttendance's output, which
// doesn't retain per-line minutes. Mirrors getDailyPeriodBreakdown's
// precedent of doing its own independent period_lines query rather than
// reusing AttendanceDataset. Nothing above this point in the file is
// touched by it, so the existing per-student reports are unaffected.

export const STATUS_GROUP_PRESENT_LABEL = 'Present'
export const STATUS_GROUP_OTHER_LABEL = 'Other'

export interface StatusGroupBucket {
  label: string
  minutes: number
  // null only when the owning scope has zero expected minutes.
  percentage: number | null
}

export interface StatusGroupScope {
  // 'Whole School' or a yearLevel value (e.g. '7'); 'Unknown' for students
  // with no roster-matched year level.
  label: string
  totalExpectedMinutes: number
  buckets: StatusGroupBucket[]
}

export interface StatusGroupPeriodBreakdown {
  periodName: string
  periodStart: string
  periodEnd: string
  wholeSchool: StatusGroupScope
  yearLevels: StatusGroupScope[]
}

// bucket order is always Present, then STATUS_GROUPS in order, then Other —
// callers (the email template) rely on this to zip a year-side and
// term-side breakdown of the same scope together by index.
function bucketStatusGroupMinutes(
  lines: AssembledAttendancePeriodLine[],
): StatusGroupBucket[] {
  const totalMinutes = lines.reduce((sum, l) => sum + l.expectedMinutes, 0)

  const presentMinutes = lines
    .filter((l) => l.statusSchoolSystemExportIdentifier === PRESENT_STATUS_EXPORT_ID)
    .reduce((sum, l) => sum + l.expectedMinutes, 0)

  const groupMinutes = STATUS_GROUPS.map((group) =>
    lines
      .filter((l) =>
        l.statusSchoolSystemExportIdentifier !== null &&
        group.has(l.statusSchoolSystemExportIdentifier)
      )
      .reduce((sum, l) => sum + l.expectedMinutes, 0)
  )

  // everything not Present and not in one of the curated groups above —
  // teaching-time activity codes, lates, suspensions, etc, plus any line
  // whose status didn't match one in the statuses table at all.
  const otherMinutes = totalMinutes - presentMinutes -
    groupMinutes.reduce((a, b) => a + b, 0)

  const raw = [
    { label: STATUS_GROUP_PRESENT_LABEL, minutes: presentMinutes },
    ...STATUS_GROUP_LABELS.map((label, i) => ({ label, minutes: groupMinutes[i] })),
    { label: STATUS_GROUP_OTHER_LABEL, minutes: otherMinutes },
  ]

  return raw.map((b) => ({
    ...b,
    percentage: totalMinutes === 0
      ? null
      : Math.round((b.minutes / totalMinutes) * 1000) / 10,
  }))
}

function buildStatusGroupScope(
  label: string,
  lines: AssembledAttendancePeriodLine[],
): StatusGroupScope {
  return {
    label,
    totalExpectedMinutes: lines.reduce((sum, l) => sum + l.expectedMinutes, 0),
    buckets: bucketStatusGroupMinutes(lines),
  }
}

// same numeric-then-alpha ordering as email-template.ts's groupByYearLevel,
// duplicated locally rather than shared since that one is keyed off
// AbsenceRow[], not raw period lines.
function sortYearLevelKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const numericA = Number(a)
    const numericB = Number(b)
    if (!Number.isNaN(numericA) && !Number.isNaN(numericB)) {
      return numericA - numericB
    }
    if (!Number.isNaN(numericA)) return -1
    if (!Number.isNaN(numericB)) return 1
    return a.localeCompare(b)
  })
}

// status-group-report.ts's single DB-fetching entry point — teaching-time
// only, minutes-weighted, matching how attendance % is calculated
// everywhere else in this app (calculateAttendancePercentages).
export async function getStatusGroupBreakdown(
  period: Period,
): Promise<StatusGroupPeriodBreakdown> {
  const end = completedPeriodEnd(period)

  const assembled = await loadAssembledLines(period.start, end, await loadReferenceData())
  // unmatched students (no roster join — see the ~97% match rate caveat on
  // personGetStudentsBasic) are dropped here, same as getStudentAttendance
  // does — there's no year level to attribute them to, so keeping them
  // would either inflate Whole School's denominator with unattributable
  // lines or need its own non-actionable "Unknown" table.
  const teachingLines = assembled.filter((l) => l.teachingTime && l.firstName !== null)

  const byYearLevel = new Map<string, AssembledAttendancePeriodLine[]>()
  for (const line of teachingLines) {
    // every remaining line is roster-matched, so yearLevel is guaranteed
    // non-null here (see queryStudentRoster/toStudentRosterEntry) — the
    // fallback only guards the type, it never actually fires.
    const key = line.yearLevel ?? 'Unknown'
    if (!byYearLevel.has(key)) {
      byYearLevel.set(key, [])
    }
    byYearLevel.get(key)!.push(line)
  }

  return {
    periodName: period.name,
    periodStart: period.start,
    periodEnd: end,
    wholeSchool: buildStatusGroupScope('Whole School', teachingLines),
    yearLevels: sortYearLevelKeys([...byYearLevel.keys()]).map((key) =>
      buildStatusGroupScope(key, byYearLevel.get(key)!)
    ),
  }
}
