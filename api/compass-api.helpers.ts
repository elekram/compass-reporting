import {
  AssembledAttendancePeriodLine,
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentAttendancePercentage,
  StudentRosterEntry,
} from './compass-api.types.ts'
import { schoolDateOfInstant } from '../config/timezone.ts'
import { isTeachingPeriod } from '../config/periods.ts'
import { groupBy, sumWhere } from '../collections.ts'

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

// marked present.
export function isPresent(code: string | null): boolean {
  return code === PRESENT_STATUS_EXPORT_ID
}

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

// ---- whole-day rules ----
// a student's day = their teaching lines on one school date (see
// isTeachingPeriod and schoolDateOfInstant). These decide Any Days, Full
// Days and away streaks, all judged against the periods the student
// actually had that day rather than the full timetable — so a short day,
// or a period the student isn't timetabled for, is neither a gap nor an
// absence.

type CodedLine = { statusSchoolSystemExportIdentifier: string | null }
type CodeRule = (code: string | null) => boolean

// away for every period they had that day, by the given rule.
export function isWholeDayAbsent(dayLines: CodedLine[], isAbsent: CodeRule): boolean {
  return dayLines.length > 0 &&
    dayLines.every((line) => isAbsent(line.statusSchoolSystemExportIdentifier))
}

// away for at least one period that day, by the given rule.
export function isAnyPeriodAbsent(dayLines: CodedLine[], isAbsent: CodeRule): boolean {
  return dayLines.some((line) => isAbsent(line.statusSchoolSystemExportIdentifier))
}

// Any Days / Full Days over one student's days.
export function countAbsenceDays(
  days: Iterable<CodedLine[]>,
  isAbsent: CodeRule,
): { any: number; full: number } {
  let any = 0
  let full = 0
  for (const dayLines of days) {
    if (isAnyPeriodAbsent(dayLines, isAbsent)) any++
    if (isWholeDayAbsent(dayLines, isAbsent)) full++
  }
  return { any, full }
}

// whether a code belongs to one of STATUS_GROUPS — shared by the per-student
// counts and the status-group percentage breakdown.
export function isInStatusGroup(group: Set<string>, code: string | null): boolean {
  return code !== null && group.has(code)
}

// total expected minutes of the lines whose code matches the rule (every
// line when no rule is given) — the basis of every minutes-weighted figure:
// attendance %, absence minutes and the status-group percentages.
export function expectedMinutesWhere(
  lines: Iterable<CodedLine & { expectedMinutes: number }>,
  isCounted: CodeRule = () => true,
): number {
  return sumWhere(
    lines,
    (line) => isCounted(line.statusSchoolSystemExportIdentifier),
    (line) => line.expectedMinutes,
  )
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

// only the school's teaching periods count (see config/periods.ts's
// isTeachingPeriod) — non-teaching blocks (before/after school, recess,
// lunch) aren't tracked uniformly across students, so including them would
// unevenly pad expectedMinutes.
export function calculateAttendancePercentages(
  lines: AssembledAttendancePeriodLine[],
): StudentAttendancePercentage[] {
  const byStudent = groupBy(
    lines.filter(isTeachingPeriod),
    (line) => line.compassPersonId,
  )

  return [...byStudent.entries()].map(([compassPersonId, studentLines]) => {
    const expectedMinutes = expectedMinutesWhere(studentLines)
    const unexplainedAbsenceMinutes = expectedMinutesWhere(
      studentLines,
      isUnexplainedAbsence,
    )
    const explainedAbsenceMinutes = expectedMinutesWhere(studentLines, isExplainedAbsence)

    // grouped by school-local date, not the UTC date in `start` (Compass
    // sends UTC — taking its date used to split every school day in two and
    // inflate Any Days and Full Days). See schoolDateOfInstant.
    const days = [
      ...groupBy(studentLines, (line) => schoolDateOfInstant(line.start)).values(),
    ]
    const unexplainedDays = countAbsenceDays(days, isUnexplainedAbsence)
    const explainedDays = countAbsenceDays(days, isExplainedAbsence)

    const { firstName, lastName, studentCode, yearLevel } = studentLines[0]

    const statusGroupCounts = STATUS_GROUPS.map((group) =>
      studentLines.filter((line) =>
        isInStatusGroup(group, line.statusSchoolSystemExportIdentifier)
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
      attendancePercentage: attendancePercentage(
        unexplainedAbsenceMinutes,
        expectedMinutes,
      ),
      explainedAttendancePercentage: attendancePercentage(
        explainedAbsenceMinutes,
        expectedMinutes,
      ),
      unexplainedDaysAny: unexplainedDays.any,
      unexplainedDaysFull: unexplainedDays.full,
      explainedDaysAny: explainedDays.any,
      explainedDaysFull: explainedDays.full,
    }
  })
}

// a fraction (0..1) as a percentage rounded to one decimal place — the
// rounding every percentage in the reports uses.
export function roundedPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10
}

// % of expected minutes attended, i.e. not absent by the given minutes;
// null when there were no expected minutes at all.
function attendancePercentage(
  absentMinutes: number,
  expectedMinutes: number,
): number | null {
  return expectedMinutes === 0
    ? null
    : roundedPercent(1 - absentMinutes / expectedMinutes)
}
