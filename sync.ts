import sql from './db.ts'
import {
  attendanceGetPeriodLinesBetweenBounds,
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
import { sendMail } from './mailer.ts'

const FIRST_SYNC_TIMESTAMP = '2023-08-01T05:46:30Z'

// claude: offset-paginated (skip/take) against a "total" re-read from Compass on
// claude: every page — if sync runs mid-school-day while rows for today are still
// claude: being written (teachers marking later periods), that total can drift
// claude: between pages and silently skip rows. A skipped row's updated_timestamp is
// claude: still older than the watermark we then record, so a normal incremental
// claude: sync never retries it — confirmed in practice (CAP0007's periods 3/4 for
// claude: 30 July were missing from period_lines despite Compass showing them
// claude: marked). This is a self-heal, not a root-cause fix: it can't stop a page
// claude: from being dropped, only guarantee a dropped row gets a fresh chance on
// claude: every run until it's within this window.
const TRAILING_RESYNC_DAYS = 14

// claude: sync_state is only ever written after a run fully completes (see bottom of
// claude: this file), so reading it back is always safe — unlike computing
// claude: MAX(updated_timestamp) live from period_lines, which would be poisoned by a
// claude: crashed/partial run (Compass's pagination order isn't guaranteed sorted by
// claude: updatedTimestamp, so a partial max() could exceed the timestamp of an
// claude: unfetched row and silently skip it on "resume").
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

// claude: periodLineId is Compass's stable identifier for a line, so it's the
// claude: natural upsert key — a row can come back again with an updated status/time
// claude: after an edit, and we want the latest version rather than a duplicate.
// claude: called once per page (see attendanceGetPeriodLinesBetweenBounds's onPage)
// claude: rather than once at the end, so a mid-sync failure still leaves everything
// claude: fetched so far durably written instead of lost in memory.
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

// claude: statuses is a small, non-paginated reference list (not per-row data like
// claude: period_lines), so it's just refreshed in full on every sync run rather than
// claude: tracked incrementally.
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

// claude: student roster is a small, non-paginated list (not per-row data like
// claude: period_lines), so — same as statuses — it's just refreshed in full on every
// claude: sync run rather than tracked incrementally. Cached so report generation
// claude: (send-report.ts et al.) reads names/codes/year levels from Postgres instead
// claude: of making its own live Compass calls on every send.
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

// claude: updated at the start of each phase in runSync — read by the failure email
// claude: (see renderSyncFailureEmail) so a scheduled run that dies mid-sync says
// claude: plainly which phase it was in ("fetching students from Compass") rather
// claude: than making the reader infer that from a stack trace pointing at internal
// claude: function names.
let currentStage = 'starting up'

async function runSync(): Promise<SyncSummary> {
  const startedAt = new Date().toISOString()
  const today = startedAt.substring(0, 10)

  currentStage = 'fetching statuses from Compass'
  const statuses = await attendanceGetStatuses()
  await upsertStatuses(statuses)
  console.log(`sync.ts: upserted ${statuses.length} statuses`)

  currentStage = 'fetching students from Compass'
  const students = await personGetStudentsBasic()
  await upsertStudents(students)
  console.log(`sync.ts: upserted ${students.length} students`)

  currentStage = 'reading sync watermark from Postgres'
  const syncState = await getSyncState()

  let modifiedSinceTimestamp: string
  let startSkip = 0

  if (syncState) {
    modifiedSinceTimestamp = syncState.lastSyncedTimestamp
  } else {
    // claude: no completed sync on record yet — still working through the initial
    // claude: historical backfill. Resume pagination from where period_lines currently
    // claude: sits rather than re-fetching from skip=0: safe because we keep using the
    // claude: same fixed FIRST_SYNC_TIMESTAMP bound (not a computed watermark) and
    // claude: upserts are idempotent on period_line_id, so continuing the same
    // claude: deterministic request sequence can't skip or duplicate rows.
    modifiedSinceTimestamp = FIRST_SYNC_TIMESTAMP
    const [{ count }] = await sql<
      [{ count: string }]
    >`SELECT count(*)::text FROM period_lines`
    startSkip = Number(count)
    if (startSkip > 0) {
      console.log(
        `sync.ts: no completed sync on record — resuming initial backfill from skip=${startSkip}`,
      )
    }
  }

  console.log(`sync.ts: syncing period lines modified since ${modifiedSinceTimestamp}`)

  currentStage = 'syncing period lines from Compass (incremental)'
  let syncedCount = 0

  await attendanceGetPeriodLinesBetweenBounds(
    config.year.start,
    today,
    modifiedSinceTimestamp,
    async (page) => {
      await upsertPeriodLines(page)
      syncedCount += page.length
      console.log(`sync.ts: upserted ${syncedCount} period lines so far`)
    },
    startSkip,
  )

  console.log(`sync.ts: done, upserted ${syncedCount} period lines total`)

  // claude: unconditional — ignores modifiedSinceTimestamp entirely (passes
  // claude: FIRST_SYNC_TIMESTAMP) so every line in the window is re-fetched
  // claude: regardless of when it was last modified, not just ones Compass reports as
  // claude: recently changed. See the TRAILING_RESYNC_DAYS comment for why the
  // claude: watermark-based sync above can't be trusted to have caught everything on
  // claude: its own. Idempotent (upsert on period_line_id), so re-fetching rows we
  // claude: already have is just wasted bandwidth, not a correctness risk.
  const trailingStart = new Date()
  trailingStart.setUTCDate(trailingStart.getUTCDate() - TRAILING_RESYNC_DAYS)
  const trailingStartIso = trailingStart.toISOString().substring(0, 10)

  console.log(
    `sync.ts: running trailing resync for ${trailingStartIso} to ${today} (self-heals rows the sync above may have silently dropped)`,
  )

  currentStage = 'running trailing resync from Compass'
  let trailingSyncedCount = 0

  await attendanceGetPeriodLinesBetweenBounds(
    trailingStartIso,
    today,
    FIRST_SYNC_TIMESTAMP,
    async (page) => {
      await upsertPeriodLines(page)
      trailingSyncedCount += page.length
      console.log(
        `sync.ts: trailing resync upserted ${trailingSyncedCount} period lines so far`,
      )
    },
  )

  console.log(
    `sync.ts: trailing resync done, upserted ${trailingSyncedCount} period lines total`,
  )

  currentStage = 'recording sync watermark'
  const [{ max }] = await sql<[{ max: string | null }]>`
    SELECT max(updated_timestamp) AS max FROM period_lines
  `
  if (max) {
    await markSyncComplete(max)
    console.log(`sync.ts: recorded completed sync watermark ${max}`)
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

function renderSyncSummaryEmail(summary: SyncSummary): { subject: string; html: string } {
  const rows: [string, string][] = [
    ['Started', summary.startedAt],
    ['Finished', summary.finishedAt],
    ['Statuses upserted', String(summary.statusesCount)],
    ['Students upserted', String(summary.studentsCount)],
    ['Period lines synced (incremental)', String(summary.periodLinesSynced)],
    ['Period lines synced (trailing resync)', String(summary.trailingResyncSynced)],
    ['Synced since', summary.modifiedSinceTimestamp],
    ['New watermark', summary.watermark ?? '(unchanged — no period lines in range)'],
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

function renderSyncFailureEmail(error: unknown): { subject: string; html: string } {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack ?? '' : ''

  const html = `
    <div style="font-family: sans-serif; font-size: 14px; color: #000;">
      <p><b style="color: #c0392b;">Compass sync FAILED.</b></p>
      <p>Failed while: <b>${currentStage}</b></p>
      <p>${message}</p>
      ${
    stack
      ? `<pre style="font-size: 12px; color: #666; white-space: pre-wrap;">${stack}</pre>`
      : ''
  }
    </div>
  `

  return { subject: `[Compass Sync] FAILED — ${currentStage}`, html }
}

let summary: SyncSummary | undefined
let syncError: unknown

try {
  summary = await runSync()
} catch (error) {
  syncError = error
} finally {
  await sql.end()
}

const { subject, html } = syncError
  ? renderSyncFailureEmail(syncError)
  : renderSyncSummaryEmail(summary!)
await sendMail({ to: mailConfig.syncSummaryRecipients, subject, html })

if (syncError) {
  console.error('sync.ts: sync failed:', syncError)
  Deno.exit(1)
}
