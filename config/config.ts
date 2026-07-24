export interface Term {
  name: string
  start: string
  end: string
}

const terms: Term[] = [
  { name: 'Term 1', start: '2026-01-27', end: '2026-04-02' },
  { name: 'Term 2', start: '2026-04-20', end: '2026-06-26' },
  { name: 'Term 3', start: '2026-07-13', end: '2026-09-18' },
  { name: 'Term 4', start: '2026-10-05', end: '2026-12-18' },
]

const yearStart = terms[0].start
const yearEnd = terms[terms.length - 1].end

function getCurrentTerm(date: Date = new Date()): Term {
  const isoDate = date.toISOString().substring(0, 10)
  const term = terms.find((t) => isoDate >= t.start && isoDate <= t.end)

  if (!term) {
    throw new Error(`No configured term covers ${isoDate}`)
  }

  return term
}

const config = {
  terms,
  yearStart,
  yearEnd,
  getCurrentTerm,
}

export default config
