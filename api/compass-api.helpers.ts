import {
  AssembledAttendancePeriodLine,
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentAttendancePercentage,
  StudentBasic,
} from './compass-api.types.ts'

// claude: joins the three Compass endpoints into one flat row per period attendance
// claude: line: student identity via compassPersonId (using StudentBasic — better
// claude: match rate than the full Person object, see getStudentsBasic), status
// claude: detail via prevalentOverallStatusId -> statusId.
export function assembleAttendanceReport(
  periodLines: PeriodAttendanceLine[],
  statuses: AttendanceStatus[],
  students: StudentBasic[],
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
      preferredFirstName: student?.preferredFirstName ?? null,
      middleName: student?.middleName ?? null,
      username: student?.username ?? null,
      gender: student?.gender ?? null,
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

// claude: "500" is Compass's schoolSystemExportIdentifier for the "Unexplained"
// claude: status.
const UNEXPLAINED_STATUS_EXPORT_ID = '500'

// claude: curated by the stakeholder — the specific countedAbsence reasons worth
// claude: reporting on. Other countedAbsence statuses (accident, hospitalised,
// claude: quarantine, suspension, extended family holiday, religious/cultural
// claude: observance, school choice, the generic P/W codes, etc.) are deliberately
// claude: excluded from "explained" absence figures even though Compass counts them
// claude: as absences.
const REPORTABLE_STATUS_EXPORT_IDS = new Set([
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

// claude: stakeholder-specified groupings for the per-student breakdown row —
// claude: index order here is display order (left to right) in the report.
const STATUS_GROUPS: Set<string>[] = [
  new Set(['200', '201', '209']),
  new Set(['208', '300']),
  new Set(['211', '212']),
  new Set(['500', '806']),
  new Set(['807']),
]

// claude: only teachingTime periods count — non-teaching blocks (BS/R/L1/L2/AS)
// claude: aren't tracked uniformly across students (see conversation on periodCode
// claude: coverage), so including them would unevenly pad expectedMinutes.
export function calculateAttendancePercentages(
  lines: AssembledAttendancePeriodLine[],
): StudentAttendancePercentage[] {
  const teachingLines = lines.filter((line) => line.teachingTime)

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
      .filter((line) =>
        line.statusSchoolSystemExportIdentifier === UNEXPLAINED_STATUS_EXPORT_ID
      )
      .reduce((sum, line) => sum + line.expectedMinutes, 0)
    const explainedAbsenceMinutes = studentLines
      .filter((line) =>
        line.statusSchoolSystemExportIdentifier !== null &&
        REPORTABLE_STATUS_EXPORT_IDS.has(line.statusSchoolSystemExportIdentifier) &&
        line.statusSchoolSystemExportIdentifier !== UNEXPLAINED_STATUS_EXPORT_ID
      )
      .reduce((sum, line) => sum + line.expectedMinutes, 0)

    const linesByDate = new Map<string, AssembledAttendancePeriodLine[]>()
    for (const line of studentLines) {
      const date = line.start.substring(0, 10)
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
        line.statusSchoolSystemExportIdentifier === UNEXPLAINED_STATUS_EXPORT_ID
      ).length
      const explainedCount = dayLines.filter((line) =>
        line.statusSchoolSystemExportIdentifier !== null &&
        REPORTABLE_STATUS_EXPORT_IDS.has(line.statusSchoolSystemExportIdentifier) &&
        line.statusSchoolSystemExportIdentifier !== UNEXPLAINED_STATUS_EXPORT_ID
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
