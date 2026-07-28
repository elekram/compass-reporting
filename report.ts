import sql from './db.ts'
import { attendanceGetStatuses, personGetStudentsBasic } from './api/compass-api.ts'
import {
  assembleAttendanceReport,
  calculateAttendancePercentages,
} from './api/compass-api.helpers.ts'
import { PeriodAttendanceLine } from './api/compass-api.types.ts'
import config from './config/config.ts'

const ATTENDANCE_THRESHOLD = 80

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

const period = config.getCurrentTerm()
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

const [statuses, students] = await Promise.all([
  attendanceGetStatuses(),
  personGetStudentsBasic(),
])

const assembled = assembleAttendanceReport(periodLines, statuses, students)
const percentages = calculateAttendancePercentages(assembled)

const belowThreshold = percentages
  .filter((p) =>
    p.attendancePercentage !== null && p.attendancePercentage < ATTENDANCE_THRESHOLD
  )
  .sort((a, b) => (a.attendancePercentage ?? 0) - (b.attendancePercentage ?? 0))

console.log(
  `${period.name} (${period.start} to ${end}): ${belowThreshold.length} of ${percentages.length} students below ${ATTENDANCE_THRESHOLD}% attendance`,
)
console.table(
  belowThreshold.map((p) => ({
    Name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim(),
    Year: p.yearLevel,
    'Attendance %': p.attendancePercentage,
  })),
)

await sql.end()
