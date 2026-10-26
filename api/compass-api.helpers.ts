import {
  AssembledAttendancePeriodLine,
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentAttendancePercentage,
  StudentRosterEntry,
} from './compass-api.types.ts'
import { schoolDateIso } from '../config/timezone.ts'

// joins the three Compass endpoints into one flat row per period attendance
// line: student identity via compassPersonId (originally a live
// personGetStudentsBasic call — better match rate than the full Person object
// — now the cached `students` table, see attendance-data.ts's
// queryStudentRoster), status detail via prevalentOverallStatusId -> statusId.
export function assembleAttendanceReport(
  periodLines: PeriodAttendanceLine[],
  statuses: AttendanceStatus[],
  students: StudentRosterEntry[],
): AssembledAttendancePeriodLine[] {
  const statusById = new Map(
    statuses.map((status) => [status.statusId, status]),
  )

  const studentByCompassPersonId = new Map(
    students.map((student) => [student.compassPersonId, student]),
  )

  return periodLines.map((line) => {
    const { __type, ...lineFields } = line
    const student = studentByCompassPersonId.get(line.compassPersonId)
    const status = statusById.get(line.prevalentOverallStatusId)

    return {
      ...lineFields,
      firstName: student?.firstName ?? null,
      lastName: student?.lastName ?? null,
      // not part of the cached roster (see StudentRosterEntry) — nothing
      // downstream reads these, so they're always null rather than pulled
      // from a live API call just to populate an unused field.
      preferredFirstName: null,
      middleName: null,
      username: null,
      gender: null,
      yearLevel: student?.yearLevel ?? null,
      studentCode: student?.studentCode ?? null,
      statusName: status?.name ?? null,
      statusShortCode: status?.shortCode ?? null,
      statusSchoolSystemExportIdentifier: status?.schoolSystemExportIdentifier ?? null,
      statusDescription: status?.description ?? null,
      countedAbsence: status?.countedAbsence ?? null,
    }
  })
}

// "500" is Compass's schoolSystemExportIdentifier for the "Unexplained"
// status.
export const UNEXPLAINED_STATUS_EXPORT_ID = '500'

// "100" is Compass's schoolSystemExportIdentifier for the "Present" status —
// used to colour the daily period-breakdown table green.
export const PRESENT_STATUS_EXPORT_ID = '100'

// curated by the stakeholder — the specific countedAbsence reasons worth
// reporting on. Other countedAbsence statuses (accident, hospitalised,
// quarantine, suspension, extended family holiday, religious/cultural
// observance, school choice, the generic P/W codes, etc.) are deliberately
// excluded from "explained" absence figures even though Compass counts them
// as absences.
export const REPORTABLE_STATUS_EXPORT_IDS = new Set([
  '200',
  '201',
  '208',
  '209',
  '211',
  '212',
  '300',
  '500',
  '806',
  '807',
])

// ---- absence rules ----
// the one place that decides what a period's status code counts as. Every
// figure in every report goes through these, so changing what's "explained"
// (or flagged) is a change here only. All take the line's
// schoolSystemExportIdentifier, which is null when the line's status isn't
// in the statuses table.

// the "unexplained" category: code 500 only.
export function isUnexplainedAbsence(code: string | null): boolean {
  return code === UNEXPLAINED_STATUS_EXPORT_ID
}

// any of the stakeholder's curated reportable codes, unexplained (500)
// included.
export function isReportableAbsence(code: string | null): boolean {
  return code !== null && REPORTABLE_STATUS_EXPORT_IDS.has(code)
}

// the "explained" category for attendance %, Any Days and Full Days: a
// reportable code *other than* unexplained, so the two categories never
// count the same period.
export function isExplainedAbsence(code: string | null): boolean {
  return isReportableAbsence(code) && !isUnexplainedAbsence(code)
}

// whether a period pulls a student into a report's daily period breakdown
// and counts towards its away streaks. Wider than isExplainedAbsence for
// explained reports: per stakeholder request those surface unexplained
// periods alongside explained ones.
export function isFlaggedForCategory(
  category: 'unexplained' | 'explained',
  code: string | null,
): boolean {
  return category === 'unexplained'
    ? isUnexplainedAbsence(code)
    : isReportableAbsence(code)
}

// stakeholder-specified groupings for the per-student breakdown row —
// index order here is display order (left to right) in the report. Exported
// so attendance-data.ts's status-group-percentage breakdown (a separate,
// newer report) can reuse the same groupings rather than defining its own.
// email-template.ts keeps its own identical STATUS_GROUP_LABELS copy for
// the existing per-student reports — left as-is rather than pointed at this
// one, so those already-working reports stay untouched.
export const STATUS_GROUPS: Set<string>[] = [
  new Set(['200', '201', '209']),
  new Set(['208', '300']),
  new Set(['211', '212']),
  new Set(['500', '806']),
  new Set(['807']),
]

// display labels for STATUS_GROUPS, same index order — used by the new
// status-group-email-template.ts. Not consumed by email-template.ts (see
// above).
export const STATUS_GROUP_LABELS = ['200/201/209', '208/300', '211/212', '500/806', '807']

// only teachingTime periods count — non-teaching blocks (BS/R/L1/L2/AS)
// aren't tracked uniformly across students (see conversation on periodCode
// coverage), so including them would unevenly pad expectedMinutes.
export function calculateAttendancePercentages(
  lines: AssembledAttendancePeriodLine[],
): StudentAttendancePercentage[] {
  const teachingLines = lines.filter((line) => line.teachingTime)

  // every student's period 1 on a given day shares the same `start`, so a
  // whole year has only a few thousand distinct start instants across
  // hundreds of thousands of lines — each is converted to its school date
  // once and reused.
  const schoolDateByStart = new Map<string, string>()
  const schoolDateOf = (start: string): string => {
    let date = schoolDateByStart.get(start)
    if (date === undefined) {
      date = schoolDateIso(new Date(start))
      schoolDateByStart.set(start, date)
    }
    return date
  }

  const byStudent = new Map<string, AssembledAttendancePeriodLine[]>()
  for (const line of teachingLines) {
    if (!byStudent.has(line.compassPersonId)) {
      byStudent.set(line.compassPersonId, [])
    }
    byStudent.get(line.compassPersonId)!.push(line)
  }

  return [...byStudent.entries()].map(([compassPersonId, studentLines]) => {
    const expectedMinutes = studentLines.reduce(
      (sum, line) => sum + line.expectedMinutes,
      0,
    )
    const unexplainedAbsenceMinutes = studentLines
      .filter((line) => isUnexplainedAbsence(line.statusSchoolSystemExportIdentifier))
      .reduce((sum, line) => sum + line.expectedMinutes, 0)
    const explainedAbsenceMinutes = studentLines
      .filter((line) => isExplainedAbsence(line.statusSchoolSystemExportIdentifier))
      .reduce((sum, line) => sum + line.expectedMinutes, 0)

    // grouped by the school-local date, not the UTC date in `start` (Compass
    // sends UTC, e.g. "2026-02-23T22:40:00Z" for period 2 on Tue 24 Feb in
    // Melbourne). Taking the UTC date used to split every school day in two —
    // periods before ~10/11am local landed on the previous date — inflating
    // both Any Days and Full Days.
    const linesByDate = new Map<string, AssembledAttendancePeriodLine[]>()
    for (const line of studentLines) {
      const date = schoolDateOf(line.start)
      if (!linesByDate.has(date)) {
        linesByDate.set(date, [])
      }
      linesByDate.get(date)!.push(line)
    }

    let unexplainedDaysAny = 0
    let unexplainedDaysFull = 0
    let explainedDaysAny = 0
    let explainedDaysFull = 0

    for (const dayLines of linesByDate.values()) {
      const unexplainedCount = dayLines.filter((line) =>
        isUnexplainedAbsence(line.statusSchoolSystemExportIdentifier)
      ).length
      const explainedCount = dayLines.filter((line) =>
        isExplainedAbsence(line.statusSchoolSystemExportIdentifier)
      ).length

      if (unexplainedCount > 0) {
        unexplainedDaysAny++
      }
      if (unexplainedCount === dayLines.length) {
        unexplainedDaysFull++
      }
      if (explainedCount > 0) {
        explainedDaysAny++
      }
      if (explainedCount === dayLines.length) {
        explainedDaysFull++
      }
    }

    const { firstName, lastName, studentCode, yearLevel } = studentLines[0]

    const statusGroupCounts = STATUS_GROUPS.map((group) =>
      studentLines.filter((line) =>
        line.statusSchoolSystemExportIdentifier !== null &&
        group.has(line.statusSchoolSystemExportIdentifier)
      ).length
    )

    return {
      compassPersonId,
      firstName,
      lastName,
      studentCode,
      yearLevel,
      expectedMinutes,
      unexplainedAbsenceMinutes,
      explainedAbsenceMinutes,
      statusGroupCounts,
      attendancePercentage: expectedMinutes === 0
        ? null
        : Math.round((1 - unexplainedAbsenceMinutes / expectedMinutes) * 1000) /
          10,
      explainedAttendancePercentage: expectedMinutes === 0
        ? null
        : Math.round((1 - explainedAbsenceMinutes / expectedMinutes) * 1000) /
          10,
      unexplainedDaysAny,
      unexplainedDaysFull,
      explainedDaysAny,
      explainedDaysFull,
    }
  })
}
