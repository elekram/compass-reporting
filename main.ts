// API KEY 784b981c-0c7f-4ebf-b786-f6ca9eca6050
import { stringify } from '@std/csv'

// const data = [
//   { name: "Alice", age: 30, city: "New York" },
//   { name: "Bob", age: 25, city: "London" },
//   { name: "Charlie", age: 35, city: "Tokyo" },
// ];

// // Define which keys to include (columns)
// const columns = ["name", "age", "city"];

// // Convert JSON to CSV string
// const csvString = stringify(data, { columns });

// console.log(csvString);

// Optional: Write it to a file
export function getSchoolUrl() {
  return 'cheltsec-vic.compass.education'
}

export function getHeaders() {
  const h = new Headers()

  h.append('Content-Type', 'application/json')
  h.append('CompassApiKey', '784b981c-0c7f-4ebf-b786-f6ca9eca6050')

  return h
}

export async function attendanceGetPeriodLines() {
  const endpoint = '/API/V4/Attendance/GetPeriodLines'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {
          'request': {
            'lBound': '2023-01-01T05:46:30Z',
            'uBound': '2023-06-01T05:46:30Z',
            'modifiedSinceTimestamp': '2023-08-01T05:46:30Z',
            'skip': 0,
            'take': 50,
          },
        },
      ),
    },
  )

  console.log(response)
  const data = await response.text()
  const d = JSON.parse(data)
  console.log(d)
}

export async function attendanceGetStatuses() {
  const endpoint = '/api/attendance/v3/GetStatuses'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {},
      ),
    },
  )

  // console.log(response)
  const data = await response.text()
  const statusTypes = JSON.parse(data)
  // console.log(d)

  // console.log(d)

  for (const [_, statuses] of Object.entries(statusTypes)) {
    for (const status of statuses as any) {
      console.log(status.name)
    }
  }
}

export async function attendanceGetPeriodLinesBetweenBounds() {
  const endpoint = '/API/V4/Attendance/GetPeriodLinesTracking'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {
          'request': {
            'lBound': '2025-01-01T05:46:30Z',
            'uBound': '2025-06-01T05:46:30Z',
            'modifiedSinceTimestamp': '2023-08-01T05:46:30Z',
            'skip': 0,
            'take': 50,
          },
        },
      ),
    },
  )

  console.log(response)
  const data = await response.text()
  const d = JSON.parse(data)
  console.log(d)
}

export async function attendanceGetLines() {
  const endpoint = '/api/attendance/v3/GetLines'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(
        {
          'lBound': '2026-02-01T00:00:00Z',
          'uBound': '2026-04-01T00:00:00Z',
          'modifiedSince': '2016-06-10T00:00:00Z',
          'sliceType': 30,
        },
      ),
    },
  )

  console.log(response)
  const data = await response.text()
  const d = JSON.parse(data)
  console.log(d)
}

export async function referenceGetFormGroup() {
  const endpoint = '/api/reference/v4/GetFormGroups'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        'request': {
          'modifiedSinceTimestamp': '2024-01-01T00:00:00Z',
          'take': 100,
          'includeArchived': false,
        },
      }),
    },
  )

  console.log(response)

  const data = await response.text()
  const studentData = JSON.parse(data)

  console.log(studentData)
}

export async function personGetStudents() {
  const endpoint = '/API/V6/Person/GetStudents'
  const response = await fetch(
    `https://${getSchoolUrl()}${endpoint}`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        'request': {
          'lBound': '2023-01-01T05:46:30Z',
          'uBound': '2023-06-01T05:46:30Z',
          'modifiedSinceTimestamp': '2023-08-01T05:46:30Z',
          'take': 100,
          'cursor': null,
        },
      }),
    },
  )

  console.log(response)

  const data = await response.text()
  const studentData = JSON.parse(data)

  console.log(studentData)
}

export async function makeRequest() {
  const myHeaders = new Headers()
  myHeaders.append('Content-Type', 'application/json')
  myHeaders.append('CompassApiKey', '784b981c-0c7f-4ebf-b786-f6ca9eca6050')

  const response = await fetch(
    'https://cheltsec-vic.compass.education/api/attendance/v3/GetLines',
    {
      method: 'POST',
      headers: myHeaders,
      body: JSON.stringify({
        'lBound': '2020-04-01T00:00:00Z',
        'uBound': '2020-05-31T00:00:00Z',
        'modifiedSince': '2016-06-10T00:00:00Z',
        'sliceType': 30,
      }),
    },
  )

  console.log(response)

  const data = await response.text()
  const d = JSON.parse(data)
  console.log(d)

  // const csvString = stringify(JSON.parse(data), {});

  // console.log(csvString);
  // await Deno.writeTextFile("output.csv", csvString);
}

if (import.meta.main) {
  // getStudents()
  // makeRequest()
  // attendanceGetLines()
  // attendanceGetPeriodLines()
  attendanceGetPeriodLinesBetweenBounds()
  // attendanceGetStatuses()
  // referenceGetFormGroup()
}
