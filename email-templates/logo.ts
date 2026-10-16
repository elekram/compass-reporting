import { SCHOOL_LOGO_URL } from '../config/logo.ts'

// shared by email-template.ts and status-group-email-template.ts — the
// contents of the 154px-wide header cell both render top-right. Fixed width,
// height left to follow the image's own aspect ratio, since a school's logo
// won't necessarily match the 154x61 one this layout was first built around
// (a fixed height would stretch it). Empty when SCHOOL_LOGO_URL is unset, so
// the header keeps its layout with no broken image.
export function renderLogo(): string {
  if (SCHOOL_LOGO_URL === null) {
    return ''
  }
  const src = SCHOOL_LOGO_URL
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<img class="logo logo-white" src="${src}" width="154" style="width: 154px; height: auto;">`
}
