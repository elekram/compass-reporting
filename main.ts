import * as compassApis from './api/compass-api.ts'
import { assembleAttendanceReport } from './api/compass-api.helpers.ts'
// import { getAbsCsvPaths, readCsv } from './csv-methods.ts'

// console.log(await compassApis.attendanceGetLines('2026-02-01', '2026-04-01'))

const start = '2026-02-01'
const end = '2026-04-01'
const periodLines = await compassApis.attendanceGetPeriodLinesBetweenBounds(
  start,
  end,
)
const statuses = await compassApis.attendanceGetStatuses()
const students = await compassApis.personGetStudentsBasic()

console.log(assembleAttendanceReport(periodLines, statuses, students))

// const csvFilePaths = await getAbsCsvPaths()
// console.log('Found CSV files:', csvFilePaths)

// for (const filePath of csvFilePaths) {
//   console.log(`Reading CSV: ${filePath}`)
//   const data = await readCsv(filePath)
//   // console.log(`Data from ${filePath}:`, data.slice(0, 5)) // Log first 5 rows to avoid large output
//   console.log(data)
// }
