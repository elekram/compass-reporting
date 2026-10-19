import { schoolDateIso } from './timezone.ts'

export interface Period {
  name: string
  start: string
  end: string
}

// term dates come from deno.env (TERM_1, TERM_2, ... each "YYYY-MM-DD,
// YYYY-MM-DD", start and end inclusive) rather than committed literals —
// they're per-school and change every year, so a new school or a new year is
// a deno.env edit, not a code change. Read in order from TERM_1 until the
// first missing number; at least one is required. Validated strictly so a
// typo'd date fails at startup instead of silently shifting every report's
// date range: real calendar dates, start <= end, and each term starting
// after the previous one ends.
const TERM_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseTermDate(key: string, value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  // the round-trip catches dates that parse but roll over, e.g. 2026-02-30.
  if (
    !TERM_DATE.test(value) || Number.isNaN(date.getTime()) ||
    date.toISOString().substring(0, 10) !== value
  ) {
    throw new Error(
      `${key} has an invalid date "${value}" in deno.env (expected YYYY-MM-DD)`,
    )
  }
  return value
}

function readTerms(): Period[] {
  const terms: Period[] = []
  for (let n = 1;; n++) {
    const key = `TERM_${n}`
    const raw = Deno.env.get(key)
    if (!raw) {
      break
    }

    const parts = raw.split(',').map((s) => s.trim())
    if (parts.length !== 2) {
      throw new Error(
        `${key} must be "<start>,<end>" in deno.env, e.g. "2026-01-27,2026-04-02" (got "${raw}")`,
      )
    }
    const start = parseTermDate(key, parts[0])
    const end = parseTermDate(key, parts[1])
    if (start > end) {
      throw new Error(`${key} starts after it ends in deno.env (${start} > ${end})`)
    }
    const previous = terms[terms.length - 1]
    if (previous && start <= previous.end) {
      throw new Error(
        `${key} must start after TERM_${
          n - 1
        } ends in deno.env (${start} <= ${previous.end})`,
      )
    }

    terms.push({ name: `Term ${n}`, start, end })
  }

  if (terms.length === 0) {
    throw new Error('TERM_1 is not set in deno.env — at least one term is required')
  }

  // a TERM_n past the first gap (e.g. TERM_5 with no TERM_4) would otherwise
  // be silently ignored — almost certainly a typo or a deleted line.
  const stray = Object.keys(Deno.env.toObject()).filter((key) => {
    const match = key.match(/^TERM_(\d+)$/)
    return match !== null && Number(match[1]) > terms.length
  })
  if (stray.length > 0) {
    throw new Error(
      `deno.env has ${stray.join(', ')} but no TERM_${
        terms.length + 1
      } — terms must be numbered from TERM_1 with no gaps`,
    )
  }
  return terms
}

const terms = readTerms()

const year: Period = {
  name: 'Year',
  start: terms[0].start,
  end: terms[terms.length - 1].end,
}

// the term the given instant falls in, judged by the school-local date (see
// schoolDateIso), or null during the holidays — between terms, or before the
// first/after the last. cron.ts uses the null to skip reports in the holidays.
function findCurrentTerm(date: Date = new Date()): Period | null {
  const isoDate = schoolDateIso(date)
  return terms.find((t) => isoDate >= t.start && isoDate <= t.end) ?? null
}

// findCurrentTerm for the manual report scripts (send-report.ts et al.),
// which have no sensible fallback during the holidays and should say so.
function getCurrentTerm(date: Date = new Date()): Period {
  const term = findCurrentTerm(date)

  if (!term) {
    throw new Error(
      `No configured term covers ${schoolDateIso(date)} (school holidays?)`,
    )
  }

  return term
}

const config = {
  terms,
  year,
  findCurrentTerm,
  getCurrentTerm,
}

export default config
