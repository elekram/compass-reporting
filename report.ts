import { stringify } from '@std/csv'
import sql from './db.ts'
import config from './config/config.ts'
import { AbsenceRow, getAttendanceReportData } from './attendance-data.ts'

const period = Deno.args.includes('year') ? config.year : config.getCurrentTerm()
const data = await getAttendanceReportData(period)

console.log(
  `${data.periodName} (${data.periodStart} to ${data.periodEnd}), ${data.totalStudents} students`,
)

console.log(`\nUnexplained absences: ${data.unexplainedRows.length} students`)
console.table(
  data.unexplainedRows.map((r) => ({
    Name: r.name,
    Year: r.yearLevel,
    'Attendance %': r.attendancePercentage,
    Trend: r.trend,
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  })),
)

console.log(`\nExplained absences: ${data.explainedRows.length} students`)
console.table(
  data.explainedRows.map((r) => ({
    Name: r.name,
    Year: r.yearLevel,
    'Attendance %': r.attendancePercentage,
    Trend: r.trend,
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  })),
)

function toCsvRows(rows: AbsenceRow[]) {
  return rows.map((r) => ({
    Name: r.name,
    Year: r.yearLevel ?? '',
    'Attendance %': r.attendancePercentage ?? '',
    Trend: r.trend ?? '',
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  }))
}

await Deno.writeTextFile(
  'unexplained-absences.csv',
  stringify(toCsvRows(data.unexplainedRows), {
    columns: ['Name', 'Year', 'Attendance %', 'Trend', 'Days*', 'Full Days'],
  }),
)
await Deno.writeTextFile(
  'explained-absences.csv',
  stringify(toCsvRows(data.explainedRows), {
    columns: ['Name', 'Year', 'Attendance %', 'Trend', 'Days*', 'Full Days'],
  }),
)
console.log('\nWrote unexplained-absences.csv and explained-absences.csv')

await sql.end()
