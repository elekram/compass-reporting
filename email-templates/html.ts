import { SCHOOL_LOGO_URL } from '../config/logo.ts'

// shared by every email template — escaping and the page layout around each
// report's own rows, so both reports look the same and a layout fix is made
// once.

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// contents of the 154px-wide header cell, top-right. Fixed width, height
// left to follow the image's own aspect ratio, since a school's logo won't
// necessarily match the 154x61 one this layout was first built around (a
// fixed height would stretch it). Empty when SCHOOL_LOGO_URL is unset, so
// the header keeps its layout with no broken image.
function renderLogo(): string {
  if (SCHOOL_LOGO_URL === null) {
    return ''
  }
  return `<img class="logo logo-white" src="${
    escapeHtml(SCHOOL_LOGO_URL)
  }" width="154" style="width: 154px; height: auto;">`
}

// the full HTML document: a 600px centred table (with the Outlook/IE
// conditional wrapper), a header row with the title on the left and the
// school logo (SCHOOL_LOGO_URL) on the right, then bodyRows — a report's own
// `<tr>…</tr>` rows, already rendered. Only the classes the templates use
// are styled; inline styles do the rest, since many email clients drop
// <style> blocks entirely.
export function renderEmailShell(title: string, bodyRows: string): string {
  return `
  <!DOCTYPE html
  PUBLIC '-//W3C//DTD XHTML 1.0 Transitional//EN' 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'>
  <html xmlns='http://www.w3.org/1999/xhtml'>

<head>
  <meta http-equiv='Content-Type' content='text/html; charset=utf-8'>
  <title>${escapeHtml(title)}</title>
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
                    <b>${escapeHtml(title)}</b>
                  </td>
                  <td style='width: 154px; text-align: right; vertical-align: middle;'>
                    ${renderLogo()}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${bodyRows}
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
