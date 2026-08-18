import './check-env.ts'
import { stringify } from '@std/csv'
import sql from './db.ts'
import config from './config/config.ts'
import { AbsenceRow, buildReportData, getStudentAttendance } from './attendance-data.ts'
import reports from './reports/registry.ts'

const [yearDataset, termDataset] = await Promise.all([
  getStudentAttendance(config.year),
  getStudentAttendance(config.getCurrentTerm()),
])

console.log(
  `${yearDataset.periodName} (${yearDataset.periodStart} to ${yearDataset.periodEnd}), ${yearDataset.totalStudents} students`,
)

function toCsvRows(rows: AbsenceRow[]) {
  return rows.map((r) => ({
    Name: r.name,
    Code: r.studentCode ?? '',
    Year: r.yearLevel ?? '',
    'Year Attendance %': r.year.attendancePercentage ?? '',
    'Year Trend': r.year.trend ?? '',
    'Year Days*': r.year.daysAny,
    'Year Full Days': r.year.daysFull,
    'Term Attendance %': r.term.attendancePercentage ?? '',
    'Term Trend': r.term.trend ?? '',
    'Term Days*': r.term.daysAny,
    'Term Full Days': r.term.daysFull,
  }))
}

for (const def of reports) {
  const data = buildReportData(yearDataset, termDataset, def)

  console.log(`\n${data.title}: ${data.rows.length} students`)
  console.table(
    data.rows.map((r) => ({
      Name: r.name,
      Code: r.studentCode,
      Year: r.yearLevel,
      'Year Attendance %': r.year.attendancePercentage,
      'Year Trend': r.year.trend,
      'Term Attendance %': r.term.attendancePercentage,
      'Term Trend': r.term.trend,
    })),
  )

  const outFile = `${def.id}.csv`
  await Deno.writeTextFile(
    outFile,
    stringify(toCsvRows(data.rows), {
      columns: [
        'Name',
        'Code',
        'Year',
        'Year Attendance %',
        'Year Trend',
        'Year Days*',
        'Year Full Days',
        'Term Attendance %',
        'Term Trend',
        'Term Days*',
        'Term Full Days',
      ],
    }),
  )
  console.log(`Wrote ${outFile}`)
}

await sql.end()
