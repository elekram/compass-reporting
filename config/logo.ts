// the school logo shown in the top-right of every report email, from deno.env
// so each school can use its own. Optional, unlike the rest of deno.env: a
// school with no publicly hosted logo is a legitimate setup, and the only
// cost of leaving it out is a header without an image. Must be a public
// http(s) URL — email clients fetch it when the message is opened, so a
// local file path or an intranet address would show as a broken image.
const raw = Deno.env.get('SCHOOL_LOGO_URL') || null

let logoUrl: string | null = null
if (raw !== null) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(
      `SCHOOL_LOGO_URL must be a full image URL in deno.env, e.g. "https://www.yourschool.edu.au/logo.png" (got "${raw}")`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `SCHOOL_LOGO_URL must be an http(s) URL in deno.env (got "${raw}")`,
    )
  }
  logoUrl = url.href
}

export const SCHOOL_LOGO_URL = logoUrl
