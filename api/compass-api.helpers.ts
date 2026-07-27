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
      statusName: status?.name ?? null,
      statusShortCode: status?.shortCode ?? null,
      statusSchoolSystemExportIdentifier:
        status?.schoolSystemExportIdentifier ?? null,
      statusDescription: status?.description ?? null,
      countedAbsence: status?.countedAbsence ?? null,
    }
  })
}

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
    const countedAbsenceMinutes = studentLines
      .filter((line) => line.countedAbsence)
      .reduce((sum, line) => sum + line.expectedMinutes, 0)

    const { firstName, lastName, yearLevel } = studentLines[0]

    return {
      compassPersonId,
      firstName,
      lastName,
      yearLevel,
      expectedMinutes,
      countedAbsenceMinutes,
      attendancePercentage: expectedMinutes === 0
        ? null
        : Math.round((1 - countedAbsenceMinutes / expectedMinutes) * 1000) /
          10,
    }
  })
}
