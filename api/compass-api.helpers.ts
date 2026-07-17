import {
  AssembledAttendancePeriodLine,
  AttendanceStatus,
  PeriodAttendanceLine,
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
    }
  })
}
