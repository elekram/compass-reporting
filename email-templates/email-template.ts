import { AbsenceRow, AttendanceReportData } from '../attendance-data.ts'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// claude: groups preserve the incoming row order (rows arrive pre-sorted ascending
// claude: by attendancePercentage from getAttendanceReportData), so each year-level
// claude: bucket ends up sorted by percentage without needing to re-sort here.
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

// claude: bands set by stakeholder request — 85%+ green, 80-85% orange, below 80% red.
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
  const color = barColor(filled)
  return `
          <table width='120' border='0' cellpadding='0' cellspacing='0' style='border-collapse: collapse;'>
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

// claude: placeholder cells for a future per-student breakdown (exact data TBD) —
// claude: this row exists purely to lock in the table design; renderDetailRow is
// claude: the only thing that'll need to change once the real values are known.
const DETAIL_PLACEHOLDER_COUNT = 5

function renderDetailRow(): string {
  const cells = Array.from(
    { length: DETAIL_PLACEHOLDER_COUNT },
    (_, i) => `
                  <td style='padding: 4px; width: ${
      100 / DETAIL_PLACEHOLDER_COUNT
    }%; text-align: center; font-family: sans-serif; font-size: 12px; color: #666666; background-color: #f9f7f6;'>${
      i + 1
    }</td>`,
  ).join('')

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

function renderAbsenceRows(rows: AbsenceRow[]): string {
  return rows.map((row) => `
      <tr>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: left; width: 34%;'>${
    escapeHtml(row.name)
  }</td>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #666666; text-align: left; width: 60px;'>${
    escapeHtml(row.studentCode ?? '-')
  }</td>
        <td style='padding: 6px 10px;'>${renderBar(row.attendancePercentage)}</td>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: right; width: 50px;'>${
    row.attendancePercentage ?? '-'
  }%</td>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 13px; text-align: right; width: 70px;'>${
    renderTrend(row.trend)
  }</td>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: right; width: 40px;'>${row.daysAny}</td>
        <td style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: right; width: 40px;'>${row.daysFull}</td>
      </tr>${renderDetailRow()}`).join('')
}

function renderYearLevelTable(yearLevel: string, rows: AbsenceRow[]): string {
  return `
          <tr>
            <td class='innerpadding'
              style='padding: 12px 0px 4px 0px; font-family: sans-serif; font-size: 15px; font-weight: bold; color: #283747;'>
              Year ${escapeHtml(yearLevel)} (${rows.length})
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom' style='padding: 0px 0px 10px 0px; border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Name</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Code</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747;'>&nbsp;</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;'>Attendance</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;'>Trend</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;' title='Days with at least one qualifying period'>Days*</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;' title='Full days'>Full Days</td>
                </tr>
                ${renderAbsenceRows(rows)}
              </table>
            </td>
          </tr>`
}

function renderAbsenceBody(rows: AbsenceRow[]): string {
  const yearTables = groupByYearLevel(rows)
    .map(([yearLevel, groupRows]) => renderYearLevelTable(yearLevel, groupRows))
    .join('')

  return `
          ${
    rows.length === 0 ? '' : `
          <tr>
            <td class='innerpadding'
              style='padding: 15px 0px 8px 0px; font-family: sans-serif; font-size: 12px; color: #666666;'>
              Days* = at least one period this term; Full Days = every period that day. Green 85%+, orange 80-85%, red below 80%. Trend compares the last 14 days to the 14 days before that.
            </td>
          </tr>`
  }
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
  return `
  <!DOCTYPE html
  PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN' 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'>
  <html xmlns='http://www.w3.org/1999/xhtml'>

<head>
  <meta http-equiv='Content-Type' content='text/html; charset=utf-8'>
  <title>CSC</title>
  <style type='text/css'>
    body {
      margin: 0;
      padding: 0;
      min-width: 100% !important;
    }

    img {
      height: auto;
    }

    .content {
      width: 100%;
      max-width: 600px;
    }

    .header {
      padding: 40px 30px 20px 30px;
    }

    .innerpadding {
      padding: 30px 30px 30px 30px;
    }

    .borderbottom {
      border-bottom: 1px solid #f2eeed;
    }

    .subhead {
      font-size: 15px;
      color: #ffffff;
      font-family: sans-serif;
      letter-spacing: 10px;
      text-align: center;
    }

    .h1,
    .bodycopy {
      color: #EC9E26;
      font-family: sans-serif;
    }

    .h2 {
      color: #000000;
      font-family: sans-serif;
    }

    .h1 {
      font-size: 28px;
      line-height: 38px;
      font-weight: bold;
    }

    .h2 {
      padding: 0 0 15px 0;
      font-size: 24px;
      line-height: 28px;
      font-weight: bold;
    }

    .fbButton {
      font-size: 12px;
      text-decoration: none;
      font-family: sans-serif;
      color: #ffffff;
    }

    .bodycopy {
      color: #000000;
      font-size: 16px;
      line-height: 22px;
    }

    .bodycopysmaller {
      color: #000000;
      font-size: 14px;
      line-height: 22px;
      font-family: sans-serif;
    }

    .button {
      text-align: center;
      font-size: 18px;
      font-family: sans-serif;
      font-weight: bold;
      padding: 0 30px 0 30px;
    }

    .button a {
      color: #ffffff;
      text-decoration: none;
    }

    .footer {
      padding: 20px 30px 15px 30px;
    }

    .footercopy {
      font-family: sans-serif;
      font-size: 14px;
      color: #ffffff;
    }

    .footercopy a {
      color: #ffffff;
      text-decoration: underline;
    }

    .activate {
      margin-top: 20px;
      padding: 10px 50px 10px 50px;
      text-align: center;
      background: #666666;
      border-radius: 3px;
      text-decoration: none !important;
      font-weight: bold;
    }

    code {
      font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
      background-color: #F9F2F4;
      color: #C7254E;
      padding: 3px;
    }

    @media only screen and (max-width: 550px),
    screen and (max-device-width: 550px) {
      body[yahoo] .hide {
        display: none !important;
      }

      body[yahoo] .buttonwrapper {
        background-color: transparent !important;
      }

      body[yahoo] .button {
        padding: 0px !important;
      }

      body[yahoo] .button a {
        background-color: #e05443;
        padding: 15px 15px 13px !important;
      }

    }

    /*@media only screen and (min-device-width: 601px) {
    .content {width: 600px !important;}
    .col425 {width: 425px!important;}
    .col380 {width: 380px!important;}
    }*/
  </style>
</head>

<body yahoo bgcolor='#ffffff' border: 1px solid #e5e5e5; style='margin: 0;padding: 0;min-width: 100%!important;'>
  <table width='100%' bgcolor='#ffffff' border='0' cellpadding='0' cellspacing='0'>
    <tr>
      <td>
        <!--[if (gte mso 9)|(IE)]>
      <table width='600' align='center' cellpadding='0' cellspacing='0' border='0'>
        <tr>
          <td>
      <![endif]-->
        <table bgcolor='#ffffff' class='content' align='center' cellpadding='0' cellspacing='0' border='0'
          style='width: 100%;max-width: 600px;'>
          <tr>
            <td class='innerpadding borderbottom'
            style='padding: 5px 0px 10px 0px;border-bottom: 1px solid #f2eeed; font-family: sans-serif; font-size: 14px; text-align:left;'>
            <img class="logo logo-white" src="https://www.cheltsec.vic.edu.au/sig/chelt-logo.png">
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom'
              style='padding: 15px 0px 15px 0px;border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td colspan="2" style='color: #283747;font-family: sans-serif; border:0px solid #f2eeed; padding: 0px 0px 13px 0px; font-size: 18px; vertical-align: top;text-align:center;'>
                    <b>${escapeHtml(data.title)}</b>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom'
              style='padding: 15px 0px 10px 0px;border-bottom: 0px solid #f2eeed; font-family: sans-serif; font-size: 16px;'>
              ${
    escapeHtml(data.periodName)
  } (${data.periodStart} to ${data.periodEnd}) &mdash;
              ${data.rows.length} of ${data.totalStudents} students.
            </td>
          </tr>
          ${renderAbsenceBody(data.rows)}
          <tr>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  <!--[if (gte mso 9)|(IE)]>
          </td>
        </tr>
    </table>
    <![endif]-->
</body>
</html>`
}
