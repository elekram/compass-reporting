import { STATUS_GROUP_LABELS } from '../api/compass-api.helpers.ts'
import {
  STATUS_GROUP_OTHER_LABEL,
  STATUS_GROUP_PRESENT_LABEL,
  StatusGroupBucket,
} from '../attendance-data.ts'
import { StatusGroupReportData, StatusGroupTable } from '../status-group-report.ts'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// colours keyed by bucket label rather than positional index, so a future
// reorder of STATUS_GROUPS (api/compass-api.helpers.ts) can't silently
// mismatch a bucket with the wrong colour.
const GROUP_COLORS = ['#3498db', '#e67e22', '#9b59b6', '#c0392b', '#EC9E26']

const BUCKET_COLORS: Record<string, string> = {
  [STATUS_GROUP_PRESENT_LABEL]: '#27ae60',
  ...Object.fromEntries(STATUS_GROUP_LABELS.map((label, i) => [label, GROUP_COLORS[i]])),
  [STATUS_GROUP_OTHER_LABEL]: '#999999',
}

function bucketColor(label: string): string {
  return BUCKET_COLORS[label] ?? '#cccccc'
}

// faded tint of each bucket's colour, used as the row background so a
// scope's table reads at a glance without needing the swatch dot — same
// pastel-tint convention as DAILY_CELL_BACKGROUND in email-template.ts.
const BUCKET_BACKGROUNDS: Record<string, string> = {
  [STATUS_GROUP_PRESENT_LABEL]: '#eafaf1',
  ...Object.fromEntries(
    STATUS_GROUP_LABELS.map((label, i) => [
      label,
      ['#eaf4fc', '#fdf2e9', '#f5eef8', '#fdedec', '#fdf6e3'][i],
    ]),
  ),
  [STATUS_GROUP_OTHER_LABEL]: '#f2eeed',
}

function bucketBackground(label: string): string {
  return BUCKET_BACKGROUNDS[label] ?? '#f9f7f6'
}

// hover-tooltip text (title attribute) for each bucket's Status Group cell,
// and the copy for the legend table rendered at the top of the email —
// same idea as DAILY_CODE_LABEL in email-template.ts, but per status-group
// bucket rather than per raw code.
const BUCKET_DESCRIPTIONS: Record<string, string> = {
  [STATUS_GROUP_PRESENT_LABEL]: 'Present.',
  '200/201/209': 'Medical or illness, Dentist.',
  '208/300': "School refusal or school can't, Truancy off-site.",
  '211/212': 'Bereavement, Sorry Business.',
  '500/806': 'Unexplained, Parent choice (school unapproved).',
  '807': 'Parent choice (school approved).',
  [STATUS_GROUP_OTHER_LABEL]:
    'Everything else — lates, early departures, suspensions, non-teaching activities (camps, excursions, exams, work experience, etc), and any unmatched status.',
}

function bucketDescription(label: string): string {
  return BUCKET_DESCRIPTIONS[label] ?? ''
}

// renders once, above the Whole School section, so a reader who doesn't
// already know these code groupings can look them up without hovering over
// every row.
function renderLegend(buckets: StatusGroupBucket[]): string {
  const rows = buckets.map((b) => `
                <tr>
                  <td bgcolor='${
    bucketBackground(b.label)
  }' style='padding: 4px 10px 4px 6px; font-family: sans-serif; font-size: 12px; font-weight: bold; color: #283747; text-align: left; white-space: nowrap; border-left: 4px solid ${
    bucketColor(b.label)
  };'>${escapeHtml(b.label)}</td>
                  <td bgcolor='${
    bucketBackground(b.label)
  }' style='padding: 4px 10px; font-family: sans-serif; font-size: 12px; color: #666666; text-align: left;'>${
    escapeHtml(bucketDescription(b.label))
  }</td>
                </tr>`).join('')

  return `
          <tr>
            <td class='innerpadding'
              style='padding: 20px 0px 6px 0px; font-family: sans-serif; font-size: 14px; font-weight: bold; color: #283747;'>
              Status Groups
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom' style='padding: 0px 0px 10px 0px; border-bottom: 1px solid #f2eeed;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>${rows}
              </table>
            </td>
          </tr>`
}

// one continuous horizontal bar, one segment per bucket, width proportional
// to that bucket's share of Year to Date minutes — table-based (not CSS
// flex/grid) since this has to render inside HTML email clients.
function renderStackedBar(buckets: StatusGroupBucket[]): string {
  const cells = buckets
    .filter((b) => (b.percentage ?? 0) > 0)
    .map((b) => {
      const width = Math.max(1, Math.round(b.percentage ?? 0))
      return `<td width='${width}%' bgcolor='${
        bucketColor(b.label)
      }' style='font-size: 1px; line-height: 14px;'>&nbsp;</td>`
    })
    .join('')
  return `
          <table width='100%' border='0' cellpadding='0' cellspacing='0' style='border-collapse: collapse;'>
            <tr>${cells}</tr>
          </table>`
}

function formatPercentage(percentage: number | null): string {
  return percentage === null ? '-' : `${percentage}%`
}

function formatTrend(trend: number | null): string {
  if (trend === null) {
    return '-'
  }
  if (trend === 0) {
    return '&ndash;'
  }
  const sign = trend > 0 ? '+' : ''
  return `${sign}${trend}%`
}

function renderPercentageCell(percentage: number | null, bgcolor: string): string {
  return `
                  <td bgcolor='${bgcolor}' style='padding: 4px 10px; font-family: sans-serif; font-size: 13px; color: #000000; text-align: right;'>${
    formatPercentage(percentage)
  }</td>`
}

function renderTrendCell(trend: number | null, bgcolor: string): string {
  return `
                  <td bgcolor='${bgcolor}' style='padding: 2px 10px 6px 10px; font-family: sans-serif; font-size: 11px; color: #666666; text-align: right;'>${
    formatTrend(trend)
  }</td>`
}

function renderTableRows(table: StatusGroupTable): string {
  return table.rows.map((row) => {
    const bg = bucketBackground(row.bucketLabel)
    return `
                <tr>
                  <td bgcolor='${bg}' title='${
      escapeHtml(bucketDescription(row.bucketLabel))
    }' style='padding: 4px 10px 4px 0px; font-family: sans-serif; font-size: 13px; color: #283747; text-align: left; white-space: nowrap;'>
                    <span style='display: inline-block; width: 8px; height: 8px; background-color: ${
      bucketColor(row.bucketLabel)
    };'>&nbsp;</span>
                    ${escapeHtml(row.bucketLabel)}
                  </td>${
      row.termPercentages.map((pct) => renderPercentageCell(pct, bg)).join('')
    }${renderPercentageCell(row.yearToDatePercentage, bg)}
                </tr>
                <tr>
                  <td bgcolor='${bg}' style='padding: 0px 10px 6px 0px; font-family: sans-serif; font-size: 11px; color: #999999; text-align: left; font-style: italic;'>Trend</td>${
      row.termTrends.map((trend) => renderTrendCell(trend, bg)).join('')
    }
                  <td bgcolor='${bg}' style='padding: 2px 10px 6px 10px;'></td>
                </tr>`
  }).join('')
}

// scopeLabel is the raw yearLevel value (e.g. '7') for year-level tables —
// see attendance-data.ts's getStatusGroupBreakdown — or 'Whole School',
// which is left as-is.
function formatScopeHeading(scopeLabel: string): string {
  return /^\d+$/.test(scopeLabel) ? `Year ${scopeLabel}` : scopeLabel
}

function renderTable(table: StatusGroupTable, termNames: string[]): string {
  const termHeaders = termNames.map((name) => `
                  <td style='padding: 4px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 12px; font-weight: bold; color: #283747; text-align: right;'>${
    escapeHtml(name)
  }</td>`).join('')

  return `
          <tr>
            <td class='innerpadding'
              style='padding: 20px 0px 6px 0px; font-family: sans-serif; font-size: 16px; font-weight: bold; color: #283747;'>
              ${escapeHtml(formatScopeHeading(table.scopeLabel))}
            </td>
          </tr>
          <tr>
            <td class='innerpadding' style='padding: 0px 0px 0px 0px;'>
              <table width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td style='padding: 4px 10px 4px 0px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 12px; font-weight: bold; color: #283747; text-align: left;'>Status Group</td>${termHeaders}
                  <td style='padding: 4px 10px; border-bottom: 2px solid #283747; font-family: sans-serif; font-size: 12px; font-weight: bold; color: #283747; text-align: right;'>Year to Date</td>
                </tr>${renderTableRows(table)}
              </table>
            </td>
          </tr>
          <tr>
            <td class='innerpadding' style='padding: 10px 0px 0px 0px; font-family: sans-serif; font-size: 11px; font-weight: bold; color: #283747;'>
              Year to Date Breakdown
            </td>
          </tr>
          <tr>
            <td class='innerpadding borderbottom' style='padding: 4px 0px 10px 0px; border-bottom: 1px solid #f2eeed;'>
              ${renderStackedBar(table.yearToDateBuckets)}
            </td>
          </tr>`
}

function renderBody(data: StatusGroupReportData): string {
  const legend = renderLegend(data.wholeSchool.yearToDateBuckets)
  const wholeSchoolSection = renderTable(data.wholeSchool, data.termNames)
  const yearLevelSections = data.yearLevels
    .map((table) => renderTable(table, data.termNames))
    .join('')
  return `${legend}${wholeSchoolSection}${yearLevelSections}`
}

export default function statusGroupEmailTemplate(data: StatusGroupReportData): string {
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
    .content { width: 100%; max-width: 600px; }
    .innerpadding { padding: 30px 30px 30px 30px; }
    .borderbottom { border-bottom: 1px solid #f2eeed; }
  </style>
</head>

<body yahoo bgcolor='#ffffff' style='margin: 0; padding: 0; min-width: 100% !important;'>
  <table width='100%' bgcolor='#ffffff' border='0' cellpadding='0' cellspacing='0'>
    <tr>
      <td>
        <!--[if (gte mso 9)|(IE)]>
      <table width='600' align='center' cellpadding='0' cellspacing='0' border='0'>
        <tr>
          <td>
      <![endif]-->
        <table bgcolor='#ffffff' class='content' align='center' cellpadding='0' cellspacing='0' border='0'
          style='width: 100%; max-width: 600px;'>
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
          ${renderBody(data)}
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
