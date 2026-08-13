export interface Period {
  name: string
  start: string
  end: string
}

const terms: Period[] = [
  { name: 'Term 1', start: '2026-01-27', end: '2026-04-02' },
  { name: 'Term 2', start: '2026-04-20', end: '2026-06-26' },
  { name: 'Term 3', start: '2026-07-13', end: '2026-09-18' },
  { name: 'Term 4', start: '2026-10-05', end: '2026-12-18' },
]

// Semester 1 = Term 1 + Term 2, Semester 2 = Term 3 + Term 4 — per school
// convention, not a Compass concept.
const semesters: Period[] = [
  { name: 'Semester 1', start: terms[0].start, end: terms[1].end },
  { name: 'Semester 2', start: terms[2].start, end: terms[3].end },
]

const year: Period = {
  name: 'Year',
  start: terms[0].start,
  end: terms[terms.length - 1].end,
}

function getCurrentTerm(date: Date = new Date()): Period {
  const isoDate = date.toISOString().substring(0, 10)
  const term = terms.find((t) => isoDate >= t.start && isoDate <= t.end)

  if (!term) {
    throw new Error(`No configured term covers ${isoDate}`)
  }

  return term
}

const config = {
  terms,
  semesters,
  year,
  getCurrentTerm,
}

export default config
