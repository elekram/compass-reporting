import { stringify } from '@std/csv'
import sql from './db.ts'
import { personGetStudentsBasic } from './api/compass-api.ts'
import {
  assembleAttendanceReport,
  calculateAttendancePercentages,
} from './api/compass-api.helpers.ts'
import { AttendanceStatus, PeriodAttendanceLine } from './api/compass-api.types.ts'
import config from './config/config.ts'

const ATTENDANCE_THRESHOLD = 85

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

const period = Deno.args.includes('year') ? config.year : config.getCurrentTerm()
const today = new Date().toISOString().substring(0, 10)
// claude: term may still be in progress — don't project attendance across days
// claude: that haven't happened yet, so cap the upper bound at today.
const end = today < period.end ? today : period.end

const rows: PeriodLineRow[] = await sql`
  SELECT period_line_id, compass_person_id, campus_guid, description,
         expected_minutes, start, finish, period_code,
         prevalent_overall_status_id, standard_class_shadow, teaching_time,
         updated_timestamp
  FROM period_lines
  WHERE start >= ${period.start} AND start < ${end}::date + 1
`

const periodLines = rows.map(toPeriodAttendanceLine)

const [statusRows, students] = await Promise.all([
  sql<StatusRow[]>`SELECT * FROM statuses`,
  personGetStudentsBasic(),
])
const statuses = statusRows.map(toAttendanceStatus)

const assembled = assembleAttendanceReport(periodLines, statuses, students)
const percentages = calculateAttendancePercentages(assembled)

// claude: unmatched students (no StudentBasic join — see the ~97% match rate
// claude: caveat) are dropped here rather than shown as blank rows, since they
// claude: aren't actionable for a coordinator without a name.
const matched = percentages.filter((p) => p.firstName !== null)

const belowUnexplained = matched
  .filter((p) =>
    p.attendancePercentage !== null && p.attendancePercentage < ATTENDANCE_THRESHOLD
  )
  .sort((a, b) => (a.attendancePercentage ?? 0) - (b.attendancePercentage ?? 0))

const belowExplained = matched
  .filter((p) =>
    p.explainedAttendancePercentage !== null &&
    p.explainedAttendancePercentage < ATTENDANCE_THRESHOLD
  )
  .sort((a, b) =>
    (a.explainedAttendancePercentage ?? 0) - (b.explainedAttendancePercentage ?? 0)
  )

console.log(`${period.name} (${period.start} to ${end}), ${percentages.length} students`)

console.log(
  `\nUnexplained absences only: ${belowUnexplained.length} below ${ATTENDANCE_THRESHOLD}%`,
)
console.table(
  belowUnexplained.map((p) => ({
    Name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    Year: p.yearLevel,
    'Attendance %': p.attendancePercentage,
  })),
)

console.log(
  `\nExplained absences only: ${belowExplained.length} below ${ATTENDANCE_THRESHOLD}%`,
)
console.table(
  belowExplained.map((p) => ({
    Name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    Year: p.yearLevel,
    'Attendance %': p.explainedAttendancePercentage,
  })),
)

function toCsvRows(
  list: typeof matched,
  percentageOf: (p: (typeof matched)[number]) => number | null,
) {
  return list.map((p) => ({
    Name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    Year: p.yearLevel ?? '',
    'Attendance %': percentageOf(p) ?? '',
  }))
}

await Deno.writeTextFile(
  'unexplained-absences-below-85.csv',
  stringify(toCsvRows(belowUnexplained, (p) => p.attendancePercentage), {
    columns: ['Name', 'Year', 'Attendance %'],
  }),
)
await Deno.writeTextFile(
  'explained-absences-below-85.csv',
  stringify(toCsvRows(belowExplained, (p) => p.explainedAttendancePercentage), {
    columns: ['Name', 'Year', 'Attendance %'],
  }),
)
console.log(
  '\nWrote unexplained-absences-below-85.csv and explained-absences-below-85.csv',
)

await sql.end()
