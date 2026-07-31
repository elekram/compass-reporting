import { stringify } from '@std/csv'
import sql from './db.ts'
import config from './config/config.ts'
import { AbsenceRow, getAttendanceReportData } from './attendance-data.ts'

const ATTENDANCE_THRESHOLD = 85

const period = Deno.args.includes('year') ? config.year : config.getCurrentTerm()
const data = await getAttendanceReportData(period, ATTENDANCE_THRESHOLD)

console.log(
  `${data.periodName} (${data.periodStart} to ${data.periodEnd}), ${data.totalStudents} students`,
)

console.log(
  `\nUnexplained absences only: ${data.unexplainedBelowThreshold.length} below ${ATTENDANCE_THRESHOLD}%`,
)
console.table(
  data.unexplainedBelowThreshold.map((r) => ({
    Name: r.name,
    Year: r.yearLevel,
    'Attendance %': r.attendancePercentage,
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  })),
)

console.log(
  `\nExplained absences only: ${data.explainedBelowThreshold.length} below ${ATTENDANCE_THRESHOLD}%`,
)
console.table(
  data.explainedBelowThreshold.map((r) => ({
    Name: r.name,
    Year: r.yearLevel,
    'Attendance %': r.attendancePercentage,
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  })),
)

function toCsvRows(rows: AbsenceRow[]) {
  return rows.map((r) => ({
    Name: r.name,
    Year: r.yearLevel ?? '',
    'Attendance %': r.attendancePercentage ?? '',
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  }))
}

await Deno.writeTextFile(
  'unexplained-absences-below-85.csv',
  stringify(toCsvRows(data.unexplainedBelowThreshold), {
    columns: ['Name', 'Year', 'Attendance %', 'Days*', 'Full Days'],
  }),
)
await Deno.writeTextFile(
  'explained-absences-below-85.csv',
  stringify(toCsvRows(data.explainedBelowThreshold), {
    columns: ['Name', 'Year', 'Attendance %', 'Days*', 'Full Days'],
  }),
)
console.log(
  '\nWrote unexplained-absences-below-85.csv and explained-absences-below-85.csv',
)

await sql.end()
