import {
  AbsenceRow,
  AttendanceReportData,
  AWAY_STREAK_HIGHLIGHT_THRESHOLD,
  DailyBreakdownData,
  DailyCellKind,
  DailyPeriodCell,
  PeriodMetrics,
} from '../attendance-data.ts'
import { escapeHtml, renderEmailShell } from './html.ts'
import { weekdayOfDateIso } from '../config/timezone.ts'

// dateIso is a plain YYYY-MM-DD calendar date, so this is a straight
// string reshuffle rather than a Date parse — avoids any timezone drift.
function formatDateDdMmYyyySlash(dateIso: string): string {
  const [y, m, d] = dateIso.split('-')
  return `${d}/${m}/${y}`
}

// groups preserve the incoming row order (rows arrive pre-sorted ascending
// by attendancePercentage from getAttendanceReportData), so each year-level
// bucket ends up sorted by percentage without needing to re-sort here.
function groupByYearLevel(rows: AbsenceRow[]): Array<[string, AbsenceRow[]]> {
  const groups = new Map<string, AbsenceRow[]>()
  for (const row of rows) {
    const key = row.yearLevel ?? 'Unknown'
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(row)
  }

  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const numericA = Number(a)
    const numericB = Number(b)
    if (!Number.isNaN(numericA) && !Number.isNaN(numericB)) {
      return numericA - numericB
    }
    if (!Number.isNaN(numericA)) return -1
    if (!Number.isNaN(numericB)) return 1
    return a.localeCompare(b)
  })

  return orderedKeys.map((key) => [key, groups.get(key)!])
}

// bands set by stakeholder request — 85%+ green, 80-85% orange, below 80% red.
function barColor(percentage: number): string {
  if (percentage < 80) return '#c0392b'
  if (percentage < 85) return '#EC9E26'
  return '#27ae60'
}

function renderBar(percentage: number | null): string {
  if (percentage === null) {
    return ''
  }
  const filled = Math.max(0, Math.min(100, Math.round(percentage)))
  const empty = 100 - filled
  // color must come from the raw percentage, not `filled` — rounding first
  // (e.g. 84.7 -> 85) could cross a colour-band boundary and show green for
  // a student who's actually still below the threshold.
  const color = barColor(percentage)
  return `
          <table width='180' border='0' cellpadding='0' cellspacing='0' style='border-collapse: collapse;'>
            <tr>${
    filled > 0
      ? `<td width='${filled}%' bgcolor='${color}' style='font-size: 1px; line-height: 10px;'>&nbsp;</td>`
      : ''
  }${
    empty > 0
      ? `<td width='${empty}%' bgcolor='#f2eeed' style='font-size: 1px; line-height: 10px;'>&nbsp;</td>`
      : ''
  }</tr>
          </table>`
}

function renderTrend(trend: number | null): string {
  if (trend === null || trend === 0) {
    return `<span style='color: #666666;'>&ndash;</span>`
  }
  const color = trend > 0 ? '#27ae60' : '#c0392b'
  const arrow = trend > 0 ? '&#9650;' : '&#9660;'
  const sign = trend > 0 ? '+' : ''
  return `<span style='color: ${color};'>${arrow} ${sign}${trend}%</span>`
}

// display labels for row.statusGroupCounts — order and grouping must match
// STATUS_GROUPS in api/compass-api.helpers.ts, which is the source of truth.
const STATUS_GROUP_LABELS = ['200/201/209', '208/300', '211/212', '500/806', '807']

function renderDetailRow(statusGroupCounts: number[]): string {
  const cells = STATUS_GROUP_LABELS.map((label, i) => `
                  <td style='padding: 4px; width: ${
    100 / STATUS_GROUP_LABELS.length
  }%; text-align: center; font-family: sans-serif; background-color: #f9f7f6;'>
                    <div style='font-size: 10px; color: #999999;'>${label}</div>
                    <div style='font-size: 13px; color: #283747;'>${
    statusGroupCounts[i] ?? 0
  }</div>
                  </td>`).join('')

  return `
      <tr>
        <td colspan='7' style='padding: 0px 10px 10px 10px; border-bottom: 1px solid #f2eeed;'>
          <table width='100%' border='0' cellspacing='0' cellpadding='0'>
            <tr>${cells}
            </tr>
          </table>
        </td>
      </tr>`
}

// shared cells for a period's (Year or Term) sub-row — everything after
// the leading Name/Code/Trend cells, which only the Year sub-row renders
// (with rowspan='2') so they aren't repeated per period. Trend lives there
// rather than per-row because it's always relative to today (see
// TREND_WINDOW_DAYS), not to the row's own period — the Year and Term rows
// would otherwise show the same number twice.
function renderPeriodCells(label: string, metrics: PeriodMetrics): string {
  return `
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 13px; color: #666666; text-align: left; width: 90px; white-space: nowrap;'>${
    escapeHtml(label)
  }</td>
        <td style='padding: 6px 10px;'>${renderBar(metrics.attendancePercentage)}</td>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: right; width: 50px;'>${
    metrics.attendancePercentage ?? '-'
  }%</td>
        <td title='Days with at least one flagged period, but not necessarily the whole day' style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: right; width: 40px;'>${metrics.daysAny}</td>
        <td title='Days where every period was flagged' style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: right; width: 40px;'>${metrics.daysFull}</td>`
}

function renderAbsenceRows(rows: AbsenceRow[]): string {
  return rows.map((row) => `
      <tr>
        <td rowspan='2' style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: left; width: 34%;'>${
    escapeHtml(row.name)
  }<br><span style='font-size: 12px; color: #666666;'>${
    escapeHtml(row.studentCode ?? '-')
  }</span></td>
        <td rowspan='2' title='Most recent 14 days vs 14 days before it' style='padding: 6px 10px; font-family: sans-serif; font-size: 13px; text-align: right; width: 70px;'>${
    renderTrend(row.year.trend)
  }</td>${renderPeriodCells('Year to Date', row.year)}
      </tr>
      <tr>${renderPeriodCells('Term to Date', row.term)}
      </tr>${renderDetailRow(row.statusGroupCounts)}`).join('')
}

function renderYearLevelTable(
  yearLevel: string,
  rows: AbsenceRow[],
  threshold: number,
): string {
  return `
          <tr>
            <td class='innerpadding'
              style='padding: 24px 0px 4px 0px; font-family: sans-serif; font-size: 18px; font-weight: bold; color: #283747;'>
              ${rows.length} Students Below ${threshold}% Year to Date
            </td>
          </tr>
          ${renderBlurb(threshold)}
          <tr>
            <td class='innerpadding borderbottom' style='padding: 0px 0px 10px 0px; border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Name</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;'>Trend</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Period</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747;'>&nbsp;</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;'>Attendance</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;' title='Days with at least one flagged period, but not necessarily the whole day'>Any Day*</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;' title='Days where every period was flagged'>Full Days</td>
                </tr>
                ${renderAbsenceRows(rows)}
              </table>
            </td>
          </tr>`
}

// colours are advisory (background + text), not semantic elsewhere — chosen
// per stakeholder request so flagged codes "pop" for coordinators.
const DAILY_CELL_BACKGROUND: Record<DailyCellKind, string> = {
  present: '#eafaf1',
  flagged: '#fdedec',
  other: '#f2eeed',
  missing: '#ffffff',
}

const DAILY_CELL_TEXT: Record<DailyCellKind, string> = {
  present: '#1e8449',
  flagged: '#c0392b',
  other: '#666666',
  missing: '#999999',
}

// per-stakeholder-request emoji shown above the code in each daily-breakdown
// cell. Groupings mirror STATUS_GROUPS (compass-api.helpers.ts) except its
// last two groups (500/806 and 807) collapse to one emoji here.
const DAILY_CODE_EMOJI: Record<string, string> = {
  '200': '⚕️',
  '201': '⚕️',
  '209': '⚕️',
  '208': '🙅',
  '300': '🙅',
  '211': '😔',
  '212': '😔',
  '500': '🤷',
  '806': '🤷',
  '807': '🙆',
}

// hover-tooltip text (title attribute) for each code in a daily-breakdown
// cell — per stakeholder request. Desktop-only (no hover on mobile mail
// apps), so it's a supplement to the emoji/colour coding, not a replacement.
const DAILY_CODE_LABEL: Record<string, string> = {
  '0': 'Not Marked',
  '100': 'Present',
  '200': 'Medical',
  '201': 'Illness',
  '208': 'School Refusal',
  '209': 'Dentist',
  '211': 'Bereavement',
  '212': 'Sorry Business Related',
  '300': 'Truancy Offsite',
  '500': 'Unexplained',
  '806': 'Parent Choice Unapproved',
  '807': 'Parent Choice Approved',
}

function renderDailyCell(cell: DailyPeriodCell): string {
  const title = cell.kind === 'missing'
    ? 'Unscheduled'
    : cell.code
    ? DAILY_CODE_LABEL[cell.code]
    : undefined
  const label = cell.kind === 'missing' ? 'UN' : cell.code ?? 'UN'
  const emoji = cell.code ? DAILY_CODE_EMOJI[cell.code] : undefined
  return `
                  <td ${
    title ? `title='${escapeHtml(title)}' ` : ''
  }style='padding: 6px 4px; text-align: center; font-family: sans-serif; font-size: 12px; background-color: ${
    DAILY_CELL_BACKGROUND[cell.kind]
  }; color: ${DAILY_CELL_TEXT[cell.kind]};'>${
    emoji ? `<div style='font-size: 14px; line-height: 16px;'>${emoji}</div>` : ''
  }${escapeHtml(label)}</td>`
}

// per-stakeholder request, students away every period for more than
// AWAY_STREAK_HIGHLIGHT_THRESHOLD consecutive school days (ending on this
// table's date) get their name/code cells highlighted with the streak length
// shown, so a coordinator can spot a chronic absence at a glance rather than
// cross-referencing several days' tables by eye.
function renderDailyBreakdownRows(rows: DailyBreakdownData['rows']): string {
  return rows.map((row) => {
    const isChronic = row.awayStreakDays > AWAY_STREAK_HIGHLIGHT_THRESHOLD
    const bgcolor = isChronic ? " bgcolor='#fdecea'" : ''
    const streakBadge = isChronic
      ? ` <span style='color: #c0392b; font-weight: bold;'>(${row.awayStreakDays} days)</span>`
      : ''
    return `
                <tr>
                  <td${bgcolor} style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: left;'>${
      escapeHtml(row.name)
    }${streakBadge}</td>
                  <td${bgcolor} style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #666666; text-align: left;'>${
      escapeHtml(row.studentCode ?? '-')
    }</td>${row.cells.map(renderDailyCell).join('')}
                </tr>`
  }).join('')
}

function renderDailyDayTable(daily: DailyBreakdownData): string {
  const periodHeaders = daily.rows[0].cells.map((_, i) => `
                  <td style='padding: 6px 4px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 12px; font-weight: bold; color: #283747; text-align: center;'>P${
    i + 1
  }</td>`).join('')

  return `
          <tr>
            <td class='innerpadding'
              style='padding: 12px 0px 4px 0px; font-family: sans-serif; font-size: 15px; font-weight: bold; color: #283747;'>
              Period Breakdown - ${escapeHtml(weekdayOfDateIso(daily.date))} ${
    formatDateDdMmYyyySlash(daily.date)
  } - ${daily.rows.length} Students
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom' style='padding: 0px 0px 10px 0px; border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Name</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Code</td>${periodHeaders}
                </tr>
                ${renderDailyBreakdownRows(daily.rows)}
              </table>
            </td>
          </tr>`
}

// renders one table per complete day (see DAILY_BREAKDOWN_DAYS in
// attendance-data.ts), most recent first, with a single shared legend
// after the last one rather than repeating it per day.
function renderDailyBreakdown(days: DailyBreakdownData[]): string {
  if (days.length === 0) {
    return ''
  }

  return `${days.map(renderDailyDayTable).join('')}
          ${renderDailyLegend()}`
}

// colour swatch legend for the daily breakdown cells, matching the
// pattern used for the Bar legend in renderBlurb below.
function renderDailyLegend(): string {
  const swatchRows: [string, string][] = [
    ['#27ae60', 'Present.'],
    ['#c0392b', 'Coordinator tracked code (200/201/208/209/211/212/300/500/806/807).'],
    ['#999999', 'Untracked.'],
  ]

  const rows = swatchRows.map(([color, label]) => `
                <tr>${renderSwatch(color, label)}</tr>`).join('')

  return `
          <tr>
            <td class='innerpadding' style='padding: 8px 0px 0px 0px;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>${rows}
                <tr>
                  <td style='padding: 3px 10px 3px 0px; font-family: sans-serif; font-size: 11px; font-weight: bold; color: #283747; text-align: left; white-space: nowrap;'>UN</td>
                  <td style='padding: 3px 0px; font-family: sans-serif; font-size: 11px; color: #666666; text-align: left;'>Unscheduled.</td>
                </tr>
                <tr>
                  <td bgcolor='#fdecea' style='padding: 3px 10px 3px 0px; font-family: sans-serif; font-size: 11px; color: #c0392b; text-align: left; white-space: nowrap;'>&nbsp;</td>
                  <td style='padding: 3px 0px; font-family: sans-serif; font-size: 11px; color: #666666; text-align: left;'>Highlighted on the most recent day = away every period for more than ${AWAY_STREAK_HIGHLIGHT_THRESHOLD} consecutive school days.</td>
                </tr>
              </table>
            </td>
          </tr>`
}

// minimal explanation of the table below, shown under the "N Students
// Below X%" heading per stakeholder request — a compact label/value table
// rather than a paragraph of prose.
// small colour swatch (matches barColor's own bands, not the row-inclusion
// threshold) + label, used inline in the Bar legend row below.
function renderSwatch(color: string, label: string): string {
  return `<td style='padding: 0px 4px 0px 0px;'><table width='12' height='8' border='0' cellpadding='0' cellspacing='0'><tr><td bgcolor='${color}' style='font-size: 1px; line-height: 8px;'>&nbsp;</td></tr></table></td><td style='padding: 0px 10px 0px 0px; font-family: sans-serif; font-size: 11px; color: #666666;'>${
    escapeHtml(label)
  }</td>`
}

function renderBlurb(threshold: number): string {
  const items: [string, string][] = [
    ['Any Day*', 'At least one flagged period that day.'],
    ['Full Days', 'Every period that day was flagged.'],
    ['Trend', 'Most recent 14 days vs 14 days before it.'],
    ['Absence Codes', 'Totals for the whole year.'],
  ]

  const itemRows = items.map(([label, value]) => `
                <tr>
                  <td style='padding: 3px 10px 3px 0px; font-family: sans-serif; font-size: 11px; font-weight: bold; color: #283747; text-align: left; white-space: nowrap; vertical-align: top;'>${
    escapeHtml(label)
  }</td>
                  <td style='padding: 3px 0px; font-family: sans-serif; font-size: 11px; color: #666666; text-align: left;'>${
    escapeHtml(value)
  }</td>
                </tr>`).join('')

  const barRow = `
                <tr>
                  <td style='padding: 3px 10px 3px 0px; font-family: sans-serif; font-size: 11px; font-weight: bold; color: #283747; text-align: left; white-space: nowrap; vertical-align: middle;'>Bar</td>
                  <td style='padding: 3px 0px; vertical-align: middle;'>
                    <table border='0' cellspacing='0' cellpadding='0'>
                      <tr>${renderSwatch('#c0392b', '<80%')}${
    renderSwatch('#EC9E26', `80-${threshold}%`)
  }${renderSwatch('#27ae60', `${threshold}%+`)}</tr>
                    </table>
                  </td>
                </tr>`

  return `
          <tr>
            <td class='innerpadding' style='padding: 0px 0px 10px 0px;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>${itemRows}${barRow}
              </table>
            </td>
          </tr>`
}

function renderAbsenceBody(rows: AbsenceRow[], threshold: number): string {
  const yearTables = groupByYearLevel(rows)
    .map(([yearLevel, groupRows]) =>
      renderYearLevelTable(yearLevel, groupRows, threshold)
    )
    .join('')

  return `
          ${
    rows.length === 0
      ? `
          <tr>
            <td class='innerpadding borderbottom' style='padding: 15px 0px 15px 0px; border-bottom: 1px solid #f2eeed; font-family: sans-serif; font-size: 14px; color: #666666;'>
              No students.
            </td>
          </tr>`
      : yearTables
  }`
}

export default function emailTemplate(data: AttendanceReportData): string {
  return renderEmailShell(
    data.title,
    `
          <tr>
            <td class='innerpadding'
              style='padding: 10px 0px 0px 0px; font-family: sans-serif; font-size: 13px; color: #c0392b;'>
              Note: this email may be clipped due to its length &mdash; click "View entire message" at the bottom to see the full report.
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom'
              style='padding: 15px 0px 10px 0px;border-bottom: 0px solid #f2eeed; font-family: sans-serif; font-size: 16px;'>
              ${formatDateDdMmYyyySlash(data.periodStart)} to ${
      formatDateDdMmYyyySlash(data.periodEnd)
    } - ${data.rows.length} Students at Risk
            </td>
          </tr>
          ${renderDailyBreakdown(data.dailyBreakdown)}
          ${renderAbsenceBody(data.rows, data.threshold)}`,
  )
}
