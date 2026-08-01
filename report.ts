import { stringify } from '@std/csv'
import sql from './db.ts'
import config from './config/config.ts'
import { AbsenceRow, buildReportData, getStudentAttendance } from './attendance-data.ts'
import reports from './reports/registry.ts'

const period = Deno.args.includes('year') ? config.year : config.getCurrentTerm()
const dataset = await getStudentAttendance(period)

console.log(
  `${dataset.periodName} (${dataset.periodStart} to ${dataset.periodEnd}), ${dataset.totalStudents} students`,
)

function toCsvRows(rows: AbsenceRow[]) {
  return rows.map((r) => ({
    Name: r.name,
    Code: r.studentCode ?? '',
    Year: r.yearLevel ?? '',
    'Attendance %': r.attendancePercentage ?? '',
    Trend: r.trend ?? '',
    'Days*': r.daysAny,
    'Full Days': r.daysFull,
  }))
}

for (const def of reports) {
  const data = buildReportData(dataset, def)

  console.log(`\n${data.title}: ${data.rows.length} students`)
  console.table(
    data.rows.map((r) => ({
      Name: r.name,
      Code: r.studentCode,
      Year: r.yearLevel,
      'Attendance %': r.attendancePercentage,
      Trend: r.trend,
      'Days*': r.daysAny,
      'Full Days': r.daysFull,
    })),
  )

  const outFile = `${def.id}.csv`
  await Deno.writeTextFile(
    outFile,
    stringify(toCsvRows(data.rows), {
      columns: ['Name', 'Code', 'Year', 'Attendance %', 'Trend', 'Days*', 'Full Days'],
    }),
  )
  console.log(`Wrote ${outFile}`)
}

await sql.end()
