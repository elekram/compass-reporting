import './check-env.ts'
import sql from './db.ts'
import {
  attendanceGetPeriodLinesBetweenBounds,
  attendanceGetPeriodLinesTotal,
  attendanceGetStatuses,
  personGetStudentsBasic,
} from './api/compass-api.ts'
import {
  AttendanceStatus,
  PeriodAttendanceLine,
  StudentBasic,
} from './api/compass-api.types.ts'
import config from './config/config.ts'
import mailConfig from './config/mail-config.ts'
import { sendMail as sendMailRaw } from './mailer.ts'
import { endRun, log, logError, startRun } from './logger.ts'

const FIRST_SYNC_TIMESTAMP = '2023-08-01T05:46:30Z'

// offset-paginated (skip/take) against a "total" re-read from Compass on
// every page — if sync runs mid-school-day while rows for today are still
// being written (teachers marking later periods), that total can drift
// between pages and silently skip rows. A skipped row's updated_timestamp is
// still older than the watermark we then record, so a normal incremental
// sync never retries it — confirmed in practice (CAP0007's periods 3/4 for
// 30 July were missing from period_lines despite Compass showing them
// marked). This is a self-heal, not a root-cause fix: it can't stop a page
// from being dropped, only guarantee a dropped row gets a fresh chance on
// every run until it's within this window.
const TRAILING_RESYNC_DAYS = 14

// only a positive gap above this many rows is worth a full-term forced
// resync (see runEveningCheckAndEmail). A negative gap (DB has more rows
// than Compass is currently reporting) can't be fixed by resyncing from
// Compass at all — re-fetching the same source can't remove rows the API
// isn't reporting. And small positive gaps are within the kind of
// day-to-day pagination-total noise this check otherwise chases at a cost
// of 3-4 hours per run for no real gain (confirmed in practice: a gap of
// -142 triggered a ~3h40m resync that changed the DB row count by exactly
// 1). Sourced from deno.env rather than baked in since "how big a gap
// counts as real" is a judgment call that may need retuning without a code
// change.
const discrepancyEscalationThresholdRaw = Deno.env.get(
  'DISCREPANCY_ESCALATION_THRESHOLD',
)
if (!discrepancyEscalationThresholdRaw) {
  throw new Error('DISCREPANCY_ESCALATION_THRESHOLD is not set in deno.env')
}
const DISCREPANCY_ESCALATION_THRESHOLD = Number(discrepancyEscalationThresholdRaw)
if (
  !Number.isInteger(DISCREPANCY_ESCALATION_THRESHOLD) ||
  DISCREPANCY_ESCALATION_THRESHOLD < 0
) {
  throw new Error(
    `DISCREPANCY_ESCALATION_THRESHOLD must be a non-negative integer in deno.env (got "${discrepancyEscalationThresholdRaw}")`,
  )
}

const SCHOOL_TIMEZONE = 'Australia/Melbourne'

// the API's uBound is sent as `${end}T00:00:00Z` — an *instant*, not a local
// calendar date (see attendanceGetPeriodLinesBetweenBounds) — so an `end` of
// "2026-08-10" actually closes the window at 10am/11am Melbourne on the 10th,
// not at local midnight. This used to be handed new Date().toISOString()'s UTC
// date, which made it worse: the 07:30 Melbourne job runs at 21:30 UTC the
// *previous* day, so `end` resolved to the previous UTC date and the window
// shut at 10am on the very day being reported — periods 3-6 were never fetched
// and rendered as "Unscheduled" in the daily breakdown. Taking today's
// Melbourne date and adding a day puts the boundary at 10am tomorrow local,
// safely past the end of today's last period, whatever the DST offset is.
function syncWindowEnd(): string {
  const melbourneToday = new Date().toLocaleDateString('en-CA', {
    timeZone: SCHOOL_TIMEZONE,
  })
  const end = new Date(`${melbourneToday}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return end.toISOString().substring(0, 10)
}

// sync_state is only ever written after a run fully completes (see bottom of
// this file), so reading it back is always safe — unlike computing
// MAX(updated_timestamp) live from period_lines, which would be poisoned by a
// crashed/partial run (Compass's pagination order isn't guaranteed sorted by
// updatedTimestamp, so a partial max() could exceed the timestamp of an
// unfetched row and silently skip it on "resume").
async function getSyncState(): Promise<{ lastSyncedTimestamp: string } | null> {
  const [row] = await sql<[{ last_synced_timestamp: string }?]>`
    SELECT last_synced_timestamp FROM sync_state WHERE id = true
  `
  return row ? { lastSyncedTimestamp: row.last_synced_timestamp } : null
}

async function markSyncComplete(timestamp: string) {
  await sql`
    INSERT INTO sync_state (id, last_synced_timestamp, updated_at)
    VALUES (true, ${timestamp}, now())
    ON CONFLICT (id) DO UPDATE SET
      last_synced_timestamp = excluded.last_synced_timestamp,
      updated_at = now()
  `
}

function toRow(line: PeriodAttendanceLine) {
  return {
    period_line_id: line.periodLineId,
    compass_person_id: line.compassPersonId,
    campus_guid: line.campusGuid,
    description: line.description,
    expected_minutes: line.expectedMinutes,
    start: line.start,
    finish: line.finish,
    period_code: line.periodCode,
    prevalent_overall_status_id: line.prevalentOverallStatusId,
    standard_class_shadow: line.standardClassShadow,
    teaching_time: line.teachingTime,
    updated_timestamp: line.updatedTimestamp,
  }
}

// periodLineId is Compass's stable identifier for a line, so it's the
// natural upsert key — a row can come back again with an updated status/time
// after an edit, and we want the latest version rather than a duplicate.
// called once per page (see attendanceGetPeriodLinesBetweenBounds's onPage)
// rather than once at the end, so a mid-sync failure still leaves everything
// fetched so far durably written instead of lost in memory.
async function upsertPeriodLines(lines: PeriodAttendanceLine[]) {
  if (lines.length === 0) {
    return
  }

  const rows = lines.map(toRow)
  await sql`
    INSERT INTO period_lines ${
    sql(
      rows,
      'period_line_id',
      'compass_person_id',
      'campus_guid',
      'description',
      'expected_minutes',
      'start',
      'finish',
      'period_code',
      'prevalent_overall_status_id',
      'standard_class_shadow',
      'teaching_time',
      'updated_timestamp',
    )
  }
    ON CONFLICT (period_line_id) DO UPDATE SET
      compass_person_id = excluded.compass_person_id,
      campus_guid = excluded.campus_guid,
      description = excluded.description,
      expected_minutes = excluded.expected_minutes,
      start = excluded.start,
      finish = excluded.finish,
      period_code = excluded.period_code,
      prevalent_overall_status_id = excluded.prevalent_overall_status_id,
      standard_class_shadow = excluded.standard_class_shadow,
      teaching_time = excluded.teaching_time,
      updated_timestamp = excluded.updated_timestamp
  `
}

// statuses is a small, non-paginated reference list (not per-row data like
// period_lines), so it's just refreshed in full on every sync run rather than
// tracked incrementally.
async function upsertStatuses(statuses: AttendanceStatus[]) {
  const rows = statuses.map((status) => ({
    status_id: status.statusId,
    name: status.name,
    short_code: status.shortCode,
    short_name: status.shortName,
    description: status.description,
    school_system_export_identifier: status.schoolSystemExportIdentifier,
    counted_absence: status.countedAbsence,
    parent_selectable: status.parentSelectable,
    staff_selectable: status.staffSelectable,
  }))

  await sql`
    INSERT INTO statuses ${
    sql(
      rows,
      'status_id',
      'name',
      'short_code',
      'short_name',
      'description',
      'school_system_export_identifier',
      'counted_absence',
      'parent_selectable',
      'staff_selectable',
    )
  }
    ON CONFLICT (status_id) DO UPDATE SET
      name = excluded.name,
      short_code = excluded.short_code,
      short_name = excluded.short_name,
      description = excluded.description,
      school_system_export_identifier = excluded.school_system_export_identifier,
      counted_absence = excluded.counted_absence,
      parent_selectable = excluded.parent_selectable,
      staff_selectable = excluded.staff_selectable
  `
}

// student roster is a small, non-paginated list (not per-row data like
// period_lines), so — same as statuses — it's just refreshed in full on every
// sync run rather than tracked incrementally. Cached so report generation
// (send-report.ts et al.) reads names/codes/year levels from Postgres instead
// of making its own live Compass calls on every send.
async function upsertStudents(students: StudentBasic[]) {
  const rows = students.map((student) => ({
    compass_person_id: student.compassPersonId,
    first_name: student.firstName,
    last_name: student.lastName,
    student_code: student.studentCode,
    year_level: student.yearLevel,
  }))

  await sql`
    INSERT INTO students ${
    sql(
      rows,
      'compass_person_id',
      'first_name',
      'last_name',
      'student_code',
      'year_level',
    )
  }
    ON CONFLICT (compass_person_id) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      student_code = excluded.student_code,
      year_level = excluded.year_level,
      updated_at = now()
  `
}

interface DiscrepancyCheck {
  dbCount: number
  apiTotal: number
  gap: number
}

// compares Compass's own row count for the year-to-date window against what's
// actually in period_lines for that window — a cheap (take=1) way to detect
// the skip/take pagination drift described above (see TRAILING_RESYNC_DAYS),
// independent of whether the drift happened recently enough for the trailing
// resync to have already caught it. windowEnd is caller-supplied rather than
// computed here so a before/after pair (see runEveningCheckAndEmail) compares
// against the same window throughout — a multi-hour remediation resync that
// crosses midnight would otherwise see syncWindowEnd() advance to include a
// whole new day between the two calls, reporting a "gap" that's really just
// the window having moved rather than anything left unsynced.
async function checkPeriodLineDiscrepancy(windowEnd: string): Promise<DiscrepancyCheck> {
  const apiTotal = await attendanceGetPeriodLinesTotal(
    config.year.start,
    windowEnd,
    FIRST_SYNC_TIMESTAMP,
  )
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text FROM period_lines
    WHERE start >= ${`${config.year.start}T00:00:00Z`}
      AND start < ${`${windowEnd}T00:00:00Z`}
  `
  const dbCount = Number(count)
  return { dbCount, apiTotal, gap: apiTotal - dbCount }
}

interface SyncSummary {
  startedAt: string
  finishedAt: string
  statusesCount: number
  studentsCount: number
  periodLinesSynced: number
  trailingResyncSynced: number
  modifiedSinceTimestamp: string
  watermark: string | null
}

// updated at the start of each phase in runSync — read by the failure email
// (see renderSyncFailureEmail) so a scheduled run that dies mid-sync says
// plainly which phase it was in ("fetching students from Compass") rather
// than making the reader infer that from a stack trace pointing at internal
// function names.
let currentStage = 'starting up'

// unconditional — ignores modifiedSinceTimestamp entirely (passes
// FIRST_SYNC_TIMESTAMP) so every line in the window is re-fetched regardless
// of when it was last modified, not just ones Compass reports as recently
// changed. See the TRAILING_RESYNC_DAYS comment for why a watermark-based
// sync can't be trusted to have caught everything on its own. Idempotent
// (upsert on period_line_id), so re-fetching rows already held is just
// wasted bandwidth, not a correctness risk. Shared by runSync (every normal
// sync) and runEveningCheckAndEmail (as a cheap self-heal pass before
// deciding whether the far more expensive full-term resync is warranted).
async function runTrailingResync(windowEnd: string): Promise<number> {
  const trailingStart = new Date()
  trailingStart.setUTCDate(trailingStart.getUTCDate() - TRAILING_RESYNC_DAYS)
  const trailingStartIso = trailingStart.toISOString().substring(0, 10)

  log(
    `sync.ts: running trailing resync for ${trailingStartIso} to ${windowEnd} (self-heals rows a sync may have silently dropped)`,
  )

  let trailingSyncedCount = 0
  await attendanceGetPeriodLinesBetweenBounds(
    trailingStartIso,
    windowEnd,
    FIRST_SYNC_TIMESTAMP,
    async (page) => {
      await upsertPeriodLines(page)
      trailingSyncedCount += page.length
      log(
        `sync.ts: trailing resync upserted ${trailingSyncedCount} period lines so far`,
      )
    },
  )

  log(
    `sync.ts: trailing resync done, upserted ${trailingSyncedCount} period lines total`,
  )
  return trailingSyncedCount
}

async function runSync(): Promise<SyncSummary> {
  const startedAt = new Date().toISOString()
  const windowEnd = syncWindowEnd()

  currentStage = 'fetching statuses from Compass'
  const statuses = await attendanceGetStatuses()
  await upsertStatuses(statuses)
  log(`sync.ts: upserted ${statuses.length} statuses`)

  currentStage = 'fetching students from Compass'
  const students = await personGetStudentsBasic()
  await upsertStudents(students)
  log(`sync.ts: upserted ${students.length} students`)

  currentStage = 'reading sync watermark from Postgres'
  const syncState = await getSyncState()

  let modifiedSinceTimestamp: string
  let startSkip = 0

  if (syncState) {
    modifiedSinceTimestamp = syncState.lastSyncedTimestamp
  } else {
    // no completed sync on record yet — still working through the initial
    // historical backfill. Resume pagination from where period_lines currently
    // sits rather than re-fetching from skip=0: safe because we keep using the
    // same fixed FIRST_SYNC_TIMESTAMP bound (not a computed watermark) and
    // upserts are idempotent on period_line_id, so continuing the same
    // deterministic request sequence can't skip or duplicate rows.
    modifiedSinceTimestamp = FIRST_SYNC_TIMESTAMP
    const [{ count }] = await sql<
      [{ count: string }]
    >`SELECT count(*)::text FROM period_lines`
    startSkip = Number(count)
    if (startSkip > 0) {
      log(
        `sync.ts: no completed sync on record — resuming initial backfill from skip=${startSkip}`,
      )
    }
  }

  log(`sync.ts: syncing period lines modified since ${modifiedSinceTimestamp}`)

  currentStage = 'syncing period lines from Compass (incremental)'
  let syncedCount = 0

  await attendanceGetPeriodLinesBetweenBounds(
    config.year.start,
    windowEnd,
    modifiedSinceTimestamp,
    async (page) => {
      await upsertPeriodLines(page)
      syncedCount += page.length
      log(`sync.ts: upserted ${syncedCount} period lines so far`)
    },
    startSkip,
  )

  log(`sync.ts: done, upserted ${syncedCount} period lines total`)

  currentStage = 'running trailing resync from Compass'
  const trailingSyncedCount = await runTrailingResync(windowEnd)

  currentStage = 'recording sync watermark'
  const [{ max }] = await sql<[{ max: string | null }]>`
    SELECT max(updated_timestamp) AS max FROM period_lines
  `
  if (max) {
    await markSyncComplete(max)
    log(`sync.ts: recorded completed sync watermark ${max}`)
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    statusesCount: statuses.length,
    studentsCount: students.length,
    periodLinesSynced: syncedCount,
    trailingResyncSynced: trailingSyncedCount,
    modifiedSinceTimestamp,
    watermark: max,
  }
}

function renderSyncSummaryEmail(
  summary: SyncSummary,
  logPath: string,
): { subject: string; html: string } {
  const rows: [string, string][] = [
    ['Started', summary.startedAt],
    ['Finished', summary.finishedAt],
    ['Statuses upserted', String(summary.statusesCount)],
    ['Students upserted', String(summary.studentsCount)],
    ['Period lines synced (incremental)', String(summary.periodLinesSynced)],
    ['Period lines synced (trailing resync)', String(summary.trailingResyncSynced)],
    ['Synced since', summary.modifiedSinceTimestamp],
    ['New watermark', summary.watermark ?? '(unchanged — no period lines in range)'],
    ['Log file', logPath],
  ]

  const html = `
    <div style="font-family: sans-serif; font-size: 14px; color: #000;">
      <p><b>Compass sync completed successfully.</b></p>
      <table cellpadding="4" cellspacing="0" border="0">
        ${
    rows.map(([label, value]) =>
      `<tr><td style="color: #666;">${label}</td><td><b>${value}</b></td></tr>`
    ).join('')
  }
      </table>
    </div>
  `

  return { subject: '[Compass Sync] OK', html }
}

function renderSyncFailureEmail(
  error: unknown,
  logPath: string,
): { subject: string; html: string } {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack ?? '' : ''

  const html = `
    <div style="font-family: sans-serif; font-size: 14px; color: #000;">
      <p><b style="color: #c0392b;">Compass sync FAILED.</b></p>
      <p>Failed while: <b>${currentStage}</b></p>
      <p>${message}</p>
      <p>Log file: <code>${logPath}</code></p>
      ${
    stack
      ? `<pre style="font-size: 12px; color: #666; white-space: pre-wrap;">${stack}</pre>`
      : ''
  }
    </div>
  `

  // plain ASCII only — denomailer's RFC 2047 encoded-word folding for
  // non-ASCII Subject headers (an em dash, say) breaks mid-character on long
  // subjects, and the malformed header makes some clients (Gmail included)
  // give up parsing the whole message and show raw MIME source instead of
  // the rendered email. See mailer.ts's toBase64Mime comment for the same
  // denomailer-workaround pattern applied to the body.
  return { subject: `[Compass Sync] FAILED - ${currentStage}`, html }
}

// sendMail failures (SMTP rejection, a DNS blip, etc.) must never crash the
// whole run uncaught — confirmed the hard way: an evening resync that had
// already durably upserted 54,000 rows to Postgres was lost to an uncaught
// rejection when notifying about an unrelated Compass API timeout also hit a
// transient DNS failure. The sync/resync work is committed independently of
// this email, so losing the notification is far preferable to losing the
// process (and, for cron.ts, its scheduling) to it.
async function sendMail(
  args: { to: string | string[]; subject: string; html: string },
): Promise<void> {
  try {
    await sendMailRaw(args)
  } catch (error) {
    logError(`sync.ts: failed to send "${args.subject}" email`, error)
  }
}

// runs the sync and always emails the outcome — reused by both this file's
// own CLI entry point (deno task sync) and cron.ts's scheduled daily job, so
// there's one place that decides "sync happened, here's what to tell Mark."
// Deliberately does NOT call sql.end() or Deno.exit — cron.ts keeps the same
// process (and DB pool) alive for months between runs, so only a genuine
// one-shot CLI invocation (see the import.meta.main block below) may do that.
export async function runSyncAndEmail(): Promise<{ ok: boolean }> {
  const logPath = startRun('sync')
  log(`sync.ts: run starting, logging to ${logPath}`)

  try {
    let summary: SyncSummary | undefined
    let syncError: unknown

    try {
      summary = await runSync()
    } catch (error) {
      syncError = error
    }

    const { subject, html } = syncError
      ? renderSyncFailureEmail(syncError, logPath)
      : renderSyncSummaryEmail(summary!, logPath)
    await sendMail({ to: mailConfig.syncSummaryRecipients, subject, html })

    if (syncError) {
      logError('sync.ts: sync failed', syncError)
    } else {
      log('sync.ts: run complete')
    }

    return { ok: !syncError }
  } finally {
    endRun()
  }
}

function renderEveningCheckEmail(
  before: DiscrepancyCheck,
  after: DiscrepancyCheck | null,
  logPath: string,
): { subject: string; html: string } {
  const escalated = after !== null

  const rows: [string, string][] = [
    [
      'Discrepancy found',
      `db=${before.dbCount} api=${before.apiTotal} gap=${before.gap}`,
    ],
  ]
  if (escalated) {
    rows.push([
      'After full-term resync',
      `db=${after.dbCount} api=${after.apiTotal} gap=${after.gap}`,
    ])
  } else {
    rows.push([
      'Action taken',
      before.gap < 0
        ? 'none — gap is negative, so a resync from Compass cannot close it'
        : `none — gap is at or below the ${DISCREPANCY_ESCALATION_THRESHOLD}-row escalation threshold`,
    ])
  }
  rows.push(['Log file', logPath])

  const closed = escalated && after.gap === 0

  const html = `
    <div style="font-family: sans-serif; font-size: 14px; color: #000;">
      <p><b>${
    closed
      ? 'Evening check found and closed a period line discrepancy.'
      : escalated
      ? 'Evening check found a period line discrepancy.'
      : 'Evening check noted a period line discrepancy (below the threshold to act on).'
  }</b></p>
      <table cellpadding="4" cellspacing="0" border="0">
        ${
    rows.map(([label, value]) =>
      `<tr><td style="color: #666;">${label}</td><td><b>${value}</b></td></tr>`
    ).join('')
  }
      </table>
    </div>
  `

  return {
    // plain ASCII — see renderSyncFailureEmail's comment on the same subject
    // -encoding bug in denomailer.
    subject: closed
      ? '[Compass Sync] Evening check - discrepancy closed'
      : escalated
      ? '[Compass Sync] Evening check - discrepancy remains'
      : '[Compass Sync] Evening check - discrepancy noted',
    html,
  }
}

// runs a cheap discrepancy check (see checkPeriodLineDiscrepancy) and, only
// if it finds a gap exceeding DISCREPANCY_ESCALATION_THRESHOLD, follows up
// with a full-term forced resync — a repeat of the normal sync's trailing
// resync but widened from TRAILING_RESYNC_DAYS to the whole year-to-date
// window, since a gap surviving to this check means the drift wasn't within
// the last 14 days. Silent (no email) on evenings with no discrepancy at
// all; emails a short notice whenever a nonzero gap is found, whether or not
// it was above the threshold, negative, or resynced and left unclosed —
// see renderEveningCheckEmail.
export async function runEveningCheckAndEmail(): Promise<{ ok: boolean }> {
  const logPath = startRun('cron-evening-check')
  log(`sync.ts: evening discrepancy check starting, logging to ${logPath}`)

  try {
    let before: DiscrepancyCheck | undefined
    let after: DiscrepancyCheck | null = null
    let checkError: unknown

    // pinned once and reused for the trailing resync and both discrepancy
    // checks — see checkPeriodLineDiscrepancy's comment for why letting each
    // call recompute "now" independently is a problem for a remediation that
    // can run for hours.
    const windowEnd = syncWindowEnd()

    try {
      currentStage = 'running trailing resync from Compass'
      await runTrailingResync(windowEnd)

      currentStage = 'checking period line count against Compass'
      before = await checkPeriodLineDiscrepancy(windowEnd)
      log(
        `sync.ts: evening check — db=${before.dbCount} api=${before.apiTotal} gap=${before.gap}`,
      )

      if (before.gap > DISCREPANCY_ESCALATION_THRESHOLD) {
        log(
          `sync.ts: evening check — gap of ${before.gap} exceeds ${DISCREPANCY_ESCALATION_THRESHOLD}-row threshold, running full-term forced resync`,
        )
        currentStage = 'running full-term forced resync (evening discrepancy remediation)'
        let resyncedCount = 0
        await attendanceGetPeriodLinesBetweenBounds(
          config.year.start,
          windowEnd,
          FIRST_SYNC_TIMESTAMP,
          async (page) => {
            await upsertPeriodLines(page)
            resyncedCount += page.length
            log(`sync.ts: evening resync upserted ${resyncedCount} period lines so far`)
          },
        )
        log(
          `sync.ts: evening resync done, upserted ${resyncedCount} period lines total`,
        )

        currentStage = 'checking period line count against Compass (after resync)'
        after = await checkPeriodLineDiscrepancy(windowEnd)
        log(
          `sync.ts: evening check after resync — db=${after.dbCount} api=${after.apiTotal} gap=${after.gap}`,
        )
      } else if (before.gap !== 0) {
        log(
          `sync.ts: evening check — gap of ${before.gap} not worth resyncing (${
            before.gap < 0
              ? 'negative — a resync from Compass cannot close it'
              : `at or below the ${DISCREPANCY_ESCALATION_THRESHOLD}-row threshold`
          })`,
        )
      }
    } catch (error) {
      checkError = error
    }

    if (checkError) {
      const { subject, html } = renderSyncFailureEmail(checkError, logPath)
      await sendMail({ to: mailConfig.syncSummaryRecipients, subject, html })
      logError('sync.ts: evening discrepancy check failed', checkError)
      return { ok: false }
    }

    if (!before || before.gap === 0) {
      log('sync.ts: evening check — no discrepancy, nothing to do')
      return { ok: true }
    }

    const { subject, html } = renderEveningCheckEmail(before, after, logPath)
    await sendMail({ to: mailConfig.syncSummaryRecipients, subject, html })
    log('sync.ts: evening discrepancy check complete')
    return { ok: true }
  } finally {
    endRun()
  }
}

if (import.meta.main) {
  const { ok } = Deno.args.includes('--evening-check')
    ? await runEveningCheckAndEmail()
    : await runSyncAndEmail()
  await sql.end()
  if (!ok) {
    Deno.exit(1)
  }
}
