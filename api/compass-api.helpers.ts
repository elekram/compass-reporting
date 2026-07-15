import {
  AssembledAttendancePeriodLine,
  AttendancePeriodLine,
  AttendancePeriodLineDateObject,
  AttendanceStatus,
  GroupedAttendance,
  PeriodAttendanceLine,
  StudentBasic,
} from "./compass-api.types.ts";

export function groupAttendanceByDay(lines: AttendancePeriodLine[]): GroupedAttendance {
  const grouped = new Map<string, AttendancePeriodLineDateObject[]>();

  for (const line of lines) {
    // Convert string timestamps to Date objects
    const lineWithDates: AttendancePeriodLineDateObject = {
      ...line,
      arrivalTimestamp: new Date(line.arrivalTimestamp),
      departureTimestamp: new Date(line.departureTimestamp),
      finish: new Date(line.finish),
      start: new Date(line.start),
      updatedTimestamp: new Date(line.updatedTimestamp),
    };

    // The 'start' timestamp is the most logical field to group by.
    // We'll extract just the date part (YYYY-MM-DD).
    const date = lineWithDates.start.toISOString().substring(0, 10);

    if (!grouped.has(date)) {
      grouped.set(date, []);
    }

    // The non-null assertion (!) is safe here because we just created the array if it didn't exist.
    grouped.get(date)!.push(lineWithDates);
  }

  return grouped;
}

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
  );

  const studentByCompassPersonId = new Map(
    students.map((student) => [student.compassPersonId, student]),
  );

  return periodLines.map((line) => {
    const { __type, ...lineFields } = line;
    const student = studentByCompassPersonId.get(line.compassPersonId);
    const status = statusById.get(line.prevalentOverallStatusId);

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
    };
  });
}
