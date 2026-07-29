import sql from './db.ts'
import {
  attendanceGetPeriodLinesBetweenBounds,
  attendanceGetStatuses,
} from './api/compass-api.ts'
import { AttendanceStatus, PeriodAttendanceLine } from './api/compass-api.types.ts'
import config from './config/config.ts'

const FIRST_SYNC_TIMESTAMP = '2023-08-01T05:46:30Z'

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

const today = new Date().toISOString().substring(0, 10)

const statuses = await attendanceGetStatuses()
await upsertStatuses(statuses)
console.log(`sync.ts: upserted ${statuses.length} statuses`)

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

const [{ max }] = await sql<[{ max: string | null }]>`
  SELECT max(updated_timestamp) AS max FROM period_lines
`
if (max) {
  await markSyncComplete(max)
  console.log(`sync.ts: recorded completed sync watermark ${max}`)
}

await sql.end()
