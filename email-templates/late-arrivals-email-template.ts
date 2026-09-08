import { LATE_ARRIVAL_LABELS } from '../api/compass-api.helpers.ts'
import { LateArrivalReportData, LateArrivalRow } from '../late-arrivals-report.ts'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// same faded-yellow/darker-amber convention as the '807' bucket row in
// status-group-email-template.ts — every data row shares one row colour
// here (unlike that report, this one has no per-bucket categories to
// distinguish), with the Total column picking out the darker accent shade.
const NAME_BACKGROUND = '#FEF7E7'
const ROW_BACKGROUND = '#FCE8BB'
const TOTAL_BACKGROUND = '#FCE8BB'
const TOTAL_TEXT_COLOR = '#283747'

function renderCountCell(
  count: number,
  isTotal: boolean,
  padding: string,
  border: string,
): string {
  const bgcolor = isTotal ? TOTAL_BACKGROUND : ROW_BACKGROUND
  const color = isTotal ? TOTAL_TEXT_COLOR : '#000000'
  const weight = isTotal ? 'font-weight: bold;' : ''
  return `
                  <td bgcolor='${bgcolor}' style='padding: ${padding}; font-family: sans-serif; font-size: 14px; color: ${color}; ${weight} text-align: right;${border}'>${count}</td>`
}

// one student = two stacked rows (Year to Date on top, Term to Date below)
// under a single rowspan'd name cell — same "sub-row per period" convention
// as email-template.ts's renderAbsenceRows, but Year/Term side by side in
// one table rather than two separate tables.
function renderStudentRows(row: LateArrivalRow, isLast: boolean): string {
  const border = isLast ? '' : ' border-bottom: 1px solid #cccccc;'
  return `
                <tr>
                  <td rowspan='2' bgcolor='${NAME_BACKGROUND}' style='padding: 6px 10px; font-family: sans-serif; font-size: 14px; color: #000000; text-align: left; vertical-align: top;${border}'>${
    escapeHtml(row.name)
  }<br><span style='font-size: 12px; color: #666666;'>${
    escapeHtml(row.studentCode ?? '-')
  }</span></td>
                  <td bgcolor='${ROW_BACKGROUND}' style='padding: 6px 10px; font-family: sans-serif; font-size: 13px; color: #666666; text-align: left; white-space: nowrap;'>Year to Date</td>${
    row.year.counts.map((c) => renderCountCell(c, false, '4px 8px', '')).join('')
  }${renderCountCell(row.year.total, true, '4px 8px', '')}
                </tr>
                <tr>
                  <td bgcolor='${ROW_BACKGROUND}' style='padding: 6px 10px 10px 10px; font-family: sans-serif; font-size: 13px; color: #666666; text-align: left; white-space: nowrap;${border}'>Term to Date</td>${
    row.term.counts.map((c) => renderCountCell(c, false, '4px 8px 10px 8px', border))
      .join(
        '',
      )
  }${renderCountCell(row.term.total, true, '4px 8px 10px 8px', border)}
                </tr>`
}

function renderTable(data: LateArrivalReportData): string {
  const codeHeaders = LATE_ARRIVAL_LABELS.map((label) => `
                  <td style='padding: 6px 8px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;'>${
    escapeHtml(label)
  }</td>`).join('')

  const rows = data.rows.length === 0
    ? `
                <tr>
                  <td colspan='${
      LATE_ARRIVAL_LABELS.length + 3
    }' style='padding: 16px 10px; font-family: sans-serif; font-size: 13px; color: #666666; text-align: left;'>No late arrivals to report.</td>
                </tr>`
    : data.rows.map((row, i) => renderStudentRows(row, i === data.rows.length - 1)).join(
      '',
    )

  return `
          <tr>
            <td class='innerpadding'
              style='padding: 4px 0px 4px 0px; font-family: sans-serif; font-size: 13px; color: #666666;'>
              ${data.rows.length} student${
    data.rows.length === 1 ? '' : 's'
  } with at least one late arrival this year, sorted by Year to Date total.
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom' style='padding: 0px 0px 10px 0px; border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Name</td>
                  <td style='padding: 6px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: left;'>Period</td>${codeHeaders}
                  <td style='padding: 6px 8px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 13px; font-weight: bold; color: #283747; text-align: right;'>Total</td>
                </tr>${rows}
              </table>
            </td>
          </tr>`
}

export default function lateArrivalsEmailTemplate(data: LateArrivalReportData): string {
  return `
  <!DOCTYPE html
  PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN' 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'>
  <html xmlns='http://www.w3.org/1999/xhtml'>

<head>
  <meta http-equiv='Content-Type' content='text/html; charset=utf-8'>
  <title>CSC</title>
  <style type='text/css'>
    body { margin: 0; padding: 0; min-width: 100% !important; }
    img { height: auto; }
    .content { width: 100%; max-width: 650px; }
    .innerpadding { padding: 30px 30px 30px 30px; }
    .borderbottom { border-bottom: 1px solid #f2eeed; }
  </style>
</head>

<body yahoo bgcolor='#ffffff' style='margin: 0; padding: 0; min-width: 100% !important;'>
  <table width='100%' bgcolor='#ffffff' border='0' cellpadding='0' cellspacing='0'>
    <tr>
      <td>
        <!--[if (gte mso 9)|(IE)]>
      <table width='650' align='center' cellpadding='0' cellspacing='0' border='0'>
        <tr>
          <td>
      <![endif]-->
        <table bgcolor='#ffffff' class='content' align='center' cellpadding='0' cellspacing='0' border='0'
          style='width: 100%; max-width: 650px;'>
          <tr>
            <td class='innerpadding borderbottom'
              style='padding: 15px 0px 15px 0px; border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td style='color: #283747; font-family: sans-serif; padding: 0px 10px 0px 0px; font-size: 18px; vertical-align: middle; text-align: left;'>
                    <b>${escapeHtml(data.title)}</b>
                  </td>
                  <td style='width: 154px; text-align: right; vertical-align: middle;'>
                    <img class="logo logo-white" src="https://www.cheltsec.vic.edu.au/sig/chelt-logo.png" width="154" height="61" style="width: 154px; height: 61px;">
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${renderTable(data)}
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
