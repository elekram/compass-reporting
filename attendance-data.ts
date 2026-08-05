import sql from './db.ts'
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
  StudentRosterEntry,
} from './api/compass-api.types.ts'
import { Period } from './config/config.ts'
import { AbsenceCategory, ReportDefinition } from './reports/types.ts'

// claude: trend windows are always relative to today, independent of whatever
// claude: report period (term/year) is being generated — a coordinator wants to
// claude: know recent momentum regardless of how far back the report itself looks.
const TREND_WINDOW_DAYS = 14

// claude: default row-inclusion cutoff on attendance %, used unless a
// claude: ReportDefinition overrides it — also the band edge the email template
// claude: colours green/orange/red around.
const DEFAULT_THRESHOLD = 85

export interface PeriodMetrics {
  attendancePercentage: number | null
  daysAny: number
  daysFull: number
  // claude: percentage-point change vs. the prior TREND_WINDOW_DAYS window (e.g.
  // claude: +3.2 means attendance improved 3.2 points); null if either window has
  // claude: no expected minutes for the student (e.g. new enrolment, holidays).
  trend: number | null
}

// claude: one row = one qualifying student, carrying both their year-to-date and
// claude: current-term numbers (see buildReportData) — the email template renders
// claude: these as two sub-rows under the student's name, per stakeholder request.
export interface AbsenceRow {
  name: string
  studentCode: string | null
  yearLevel: string | null
  year: PeriodMetrics
  term: PeriodMetrics
  // claude: period-line counts per STATUS_GROUPS (compass-api.helpers.ts), same
  // claude: order, scoped to the *year* (not term) — a single running total shown
  // claude: once per student rather than split per period row.
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
  // claude: consecutive fully-absent school days ending on (and including) this
  // table's date — only computed for the most recent day's table (see
  // getDailyPeriodBreakdown), 0 everywhere else so the template's ">threshold"
  // highlight check is a harmless no-op on older days.
  awayStreakDays: number
}

// claude: "more than three days in a row" per stakeholder request — a student's
// awayStreakDays must exceed this (i.e. be 4+) to be highlighted.
export const AWAY_STREAK_HIGHLIGHT_THRESHOLD = 3

// claude: how many school days back the streak walk is willing to look — generous
// upper bound (~8 school weeks) so a genuinely long absence isn't cut short, without
// scanning the whole dataset for students who were only away for a day or two.
const AWAY_STREAK_LOOKBACK_DAYS = 40

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
  // claude: row-inclusion cutoff this report was built with (def.threshold ??
  // claude: DEFAULT_THRESHOLD) — carried through so the email template can state it
  // claude: (e.g. "Below 85%") without hardcoding the default.
  threshold: number
  rows: AbsenceRow[]
  // claude: one entry per complete day covered (see DAILY_BREAKDOWN_DAYS), most
  // claude: recent first; empty when the report didn't opt in or no days qualified.
  dailyBreakdown: DailyBreakdownData[]
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

// claude: reads the roster cached by sync.ts's upsertStudents instead of making a
// claude: live personGetStudentsBasic call — every report-generation entry point
// claude: below uses this rather than hitting Compass directly, so a send-report run
// claude: only ever depends on Compass being up at sync time, not at send time.
async function queryStudentRoster(): Promise<StudentRosterEntry[]> {
  const rows: StudentRow[] = await sql`
    SELECT compass_person_id, first_name, last_name, student_code, year_level
    FROM students
  `
  return rows.map(toStudentRosterEntry)
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

// claude: most recent complete days first (descending) — the daily breakdown
// claude: table renders them in this order, most recent day on top.
async function findMostRecentCompleteDays(count: number): Promise<string[]> {
  const rows: { day: Date }[] = await sql`
    SELECT (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date AS day
    FROM period_lines
    WHERE (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date < (now() AT TIME ZONE ${SCHOOL_TIMEZONE})::date
    GROUP BY day
    HAVING COUNT(DISTINCT compass_person_id) >= ${MIN_STUDENTS_FOR_COMPLETE_DAY}
    ORDER BY day DESC
    LIMIT ${count}
  `
  return rows.map((row) => row.day.toISOString().substring(0, 10))
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

// claude: how many of the most recent complete school days the breakdown table
// claude: covers — per stakeholder request, was 1 (just "yesterday").
const DAILY_BREAKDOWN_DAYS = 3

interface AwayStreakLineRow {
  compass_person_id: string
  day: Date
  period_code: string
  prevalent_overall_status_id: string
}

// claude: walks backward, school day by school day, from `mostRecentDay`, counting
// claude: how many consecutive days each candidate student was away every one of the
// claude: 6 teaching periods that day (same "every period flagged" test the Full Days
// claude: metric elsewhere uses) — stops at the first day that isn't a full absence,
// claude: or at the edge of AWAY_STREAK_LOOKBACK_DAYS/available school days.
async function computeAwayStreaks(
  mostRecentDay: string,
  candidateIds: string[],
  statusById: Map<string, StatusRow>,
  def: ReportDefinition,
): Promise<Map<string, number>> {
  if (candidateIds.length === 0) {
    return new Map()
  }

  const inclusionIds = def.category === 'unexplained'
    ? new Set([UNEXPLAINED_STATUS_EXPORT_ID])
    : new Set(
      [...REPORTABLE_STATUS_EXPORT_IDS].filter((id) =>
        id !== UNEXPLAINED_STATUS_EXPORT_ID
      ),
    )

  const schoolDays = await findMostRecentCompleteDays(AWAY_STREAK_LOOKBACK_DAYS)
  // claude: findMostRecentCompleteDays looks backward from "now", not from
  // claude: mostRecentDay — in normal operation mostRecentDay is schoolDays[0], but
  // claude: this guards against drift (e.g. a new day completing between the two
  // claude: calls) by anchoring the walk to mostRecentDay's own position.
  const startIndex = schoolDays.indexOf(mostRecentDay)
  const walkDays = startIndex === -1 ? [] : schoolDays.slice(startIndex)
  if (walkDays.length === 0) {
    return new Map()
  }

  const rangeStart = walkDays[walkDays.length - 1]
  const rows: AwayStreakLineRow[] = await sql`
    SELECT compass_person_id, (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date AS day,
           period_code, prevalent_overall_status_id
    FROM period_lines
    WHERE compass_person_id = ANY(${candidateIds})
      AND teaching_time = true
      AND period_code = ANY(${TEACHING_PERIOD_CODES})
      AND (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date >= ${rangeStart}
      AND (start AT TIME ZONE ${SCHOOL_TIMEZONE})::date <= ${mostRecentDay}
  `

  const codesByKey = new Map<string, Map<string, string | null>>()
  for (const row of rows) {
    const dayIso = row.day.toISOString().substring(0, 10)
    const key = `${row.compass_person_id}|${dayIso}`
    if (!codesByKey.has(key)) {
      codesByKey.set(key, new Map())
    }
    const status = statusById.get(row.prevalent_overall_status_id)
    codesByKey.get(key)!.set(
      row.period_code,
      status?.school_system_export_identifier ?? null,
    )
  }

  function isFullyAway(studentId: string, day: string): boolean {
    const periods = codesByKey.get(`${studentId}|${day}`)
    if (!periods) {
      return false
    }
    return TEACHING_PERIOD_CODES.every((code) => {
      const exportId = periods.get(code)
      return exportId != null && inclusionIds.has(exportId)
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
  statusById: Map<string, StatusRow>,
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
      return status?.school_system_export_identifier ?? null
    })

    const hasFlaggedPeriod = codes.some((code) => code !== null && inclusionIds.has(code))
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

// claude: builds the extra table(s) (opt-in via ReportDefinition.dailyPeriodBreakdown)
// claude: showing, for each of the most recent DAILY_BREAKDOWN_DAYS complete school
// claude: days, one row per student (in this report's category/yearLevels scope) who
// claude: had at least one flagged period that day, with one column per teaching
// claude: period. Separate from getStudentAttendance/buildReportData since it's
// claude: day-scoped rather than term-scoped and needs its own period_lines queries.
// claude: days with no qualifying students are dropped (mirrors the old single-day
// claude: behaviour of hiding the table entirely when empty).
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

  const [statusRows, students]: [StatusRow[], StudentRosterEntry[]] = await Promise.all([
    sql<StatusRow[]>`SELECT * FROM statuses`,
    queryStudentRoster(),
  ])
  const statusById = new Map(statusRows.map((s) => [s.status_id, s]))
  const studentById = new Map(students.map((s) => [s.compassPersonId, s]))

  const results = await Promise.all(
    days.map((day, index) =>
      buildDailyBreakdownForDay(day, statusById, studentById, def, index === 0)
    ),
  )

  return results.filter((result) => result.rows.length > 0)
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
  students: StudentRosterEntry[],
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
    queryStudentRoster(),
  ])
  const statuses = statusRows.map(toAttendanceStatus)

  const periodLines = await queryPeriodLines(period.start, addDaysIso(end, 1))
  const assembled = assembleAttendanceReport(periodLines, statuses, students)
  const percentages = calculateAttendancePercentages(assembled)
  const trends = await getTrends(statuses, students)

  // claude: unmatched students (no roster join — see the ~97% match rate caveat on
  // claude: personGetStudentsBasic) are dropped here rather than shown as blank rows,
  // claude: since they aren't actionable for a coordinator without a name.
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

// claude: shapes a year AttendanceDataset (plus the matching term dataset for the
// claude: term row) into the single-section rows a specific ReportDefinition wants.
// claude: inclusion is decided on the *year* percentage only — per stakeholder
// claude: request, a student shows up (with both their year and term rows) as soon
// claude: as their year-to-date attendance drops below the threshold, even if their
// claude: current term alone would look fine. Year-level filter, category pick,
// claude: threshold cutoff and sort all live here so reports/*.ts definitions stay
// claude: pure data.
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

// claude: buildReportData plus the opt-in daily breakdown table — the version
// claude: send-report.ts/email-preview.ts should use, since those render the full
// claude: email. report.ts (CSV/console output) has no use for the daily table, so
// claude: it calls buildReportData directly and stays synchronous.
export async function buildFullReportData(
  yearDataset: AttendanceDataset,
  termDataset: AttendanceDataset,
  def: ReportDefinition,
): Promise<AttendanceReportData> {
  const data = buildReportData(yearDataset, termDataset, def)
  const dailyBreakdown = await getDailyPeriodBreakdown(def)
  return { ...data, dailyBreakdown }
}
