# compass-reporting

Pulls student attendance data from the [Compass Education](https://www.compass.education/)
API for Cheltenham Secondary College into Postgres, and generates/emails
attendance-anomaly reports (e.g. "students below 85% explained attendance") to year level
coordinators — either on demand or on an unattended daily schedule. It also sends a
principal-facing term-by-term attendance breakdown (whole school and per year level).

## How it fits together

```
Compass API  →  sync.ts        →  Postgres (period_lines, statuses, students)
                                        │
                                        ▼
                            attendance-data.ts (shaping/filtering/trends)
                                        │
                                        ▼
     email-templates/email-template.ts / status-group-email-template.ts (HTML)
                                        │
                                        ▼
                                  mailer.ts (SMTP)
```

`cron.ts` is the unattended entry point: it runs the sync, then sends every enabled
report, once a day. `send-report.ts`, `report.ts`, and `email-preview.ts` are manual entry
points into the same underlying pipeline (`attendance-data.ts` + `reports/registry.ts`),
for testing a single report or pulling a CSV without waiting for the schedule.

Report generation never calls the Compass API directly — everything is read from Postgres,
which `sync.ts` keeps up to date. This means a report send only depends on Compass being
reachable at _sync_ time, not at _send_ time.

## Requirements

- Docker + Docker Compose
- A Compass API key (`COMPASS_API_KEY`)
- An SMTP account to send from (currently Gmail, via an app password)

## Setup

1. Create two gitignored env files in the project root:

   **`.env`** (read by `docker-compose.yaml`):
   ```
   TZ=Australia/Melbourne
   HOST_UID=1000
   HOST_GID=1000
   PG_PORT=5434
   PG_USER=postgres
   PG_PASSWORD=<postgres password>
   ```

   **`deno.env`** (read by the app inside the container, via `--env-file`):
   ```
   TZ=Australia/Melbourne
   COMPASS_API_KEY=<compass api key>
   DB_URL=postgres://postgres:<postgres password>@postgres:5432/docker
   MAIL_NO_REPLY_PASSWORD=<smtp app password>
   SYNC_SUMMARY_RECIPIENTS=you@example.com
   CRON_DEBUG_MODE=false
   CRON_DEBUG_RECIPIENTS=you@example.com
   DISCREPANCY_ESCALATION_THRESHOLD=<rows>
   ```

   `CRON_DEBUG_MODE` must be exactly `true` or `false` — `cron.ts` throws on startup for
   anything else (including unset) rather than defaulting, so a misconfigured copy can't
   silently fall through to emailing real coordinators. Set it to `true` on any dev clone.

   `DISCREPANCY_ESCALATION_THRESHOLD` is a non-negative integer: the smallest positive
   DB-vs-Compass row gap the weekly evening check will act on with a full-year resync (see
   [Scheduling](#scheduling)). Smaller gaps are just reported, never resynced.

   Every entry point imports `check-env.ts` first, which throws listing **every** missing
   variable at once. `deno task check-env` runs that check on its own.

2. `docker compose up -d` — brings up Postgres (schema created from
   `init/postgres-init.sh` on first boot only) and the `web` container running `cron.ts`.

3. The first sync is a full historical backfill (from `config.year.start`) and can take a
   while; every sync after that is incremental. See [Scheduling](#scheduling).

## Tasks

All tasks run via `docker compose run --rm web deno task <name> [-- args]`.

| Task                       | Command                                            | Purpose                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync`                     | `deno task sync`                                   | One-shot sync: statuses, student roster, and period lines from Compass into Postgres. Emails a run summary/failure alert (see `config/mail-config.ts`).                        |
| `report`                   | `deno task report`                                 | Writes a CSV + console table per registered report — no email.                                                                                                                 |
| `email-preview`            | `deno task email-preview -- [report-id]`           | Renders one report's email to `email-templates/preview-<id>.html` for viewing in a browser, without sending anything.                                                          |
| `send-report`              | `deno task send-report -- <report-id> [email...]`  | Sends one report by id. Extra args override its configured recipients — handy for testing against yourself.                                                                    |
| `send-status-group-report` | `deno task send-status-group-report -- <email...>` | Sends the term-by-term status-group breakdown to the given addresses. Pass `--preview` instead to write `email-templates/preview-status-group-breakdown.html` without sending. |
| `evening-check`            | `deno task evening-check`                          | Runs the evening discrepancy check once (trailing resync, row-count check, full-year resync only if the gap exceeds the threshold).                                            |
| `check-env`                | `deno task check-env`                              | Checks `deno.env` has every required variable, without running anything else.                                                                                                  |
| `cron`                     | `deno task cron`                                   | Registers the scheduled jobs and keeps running (this is what the `web` container runs continuously).                                                                           |
| `query`                    | `deno task query -- <name> [args...]`              | Ad-hoc CLI for pulling raw data straight from a Compass endpoint (bypasses Postgres entirely) — see `compass-query.ts` for the list of available queries.                      |

## Reports

Each report is a `ReportDefinition` (`reports/types.ts`) in its own file under `reports/`,
registered in `reports/registry.ts`:

```ts
export interface ReportDefinition {
  id: string
  title: string
  category: 'unexplained' | 'explained'
  yearLevels?: string[] // undefined = every year level
  threshold?: number // attendance % cutoff for inclusion; defaults to 85
  recipients?: string[] // default recipients for manual `send-report` calls
  dailyPeriodBreakdown?: boolean // adds the period-by-period table for recent days
}
```

Currently registered:

| id                                                         | Scope               | Category    |
| ---------------------------------------------------------- | ------------------- | ----------- |
| `explained-absences-year-7` … `explained-absences-year-12` | one year level each | explained   |
| `explained-absences`                                       | whole school        | explained   |
| `unexplained-absences`                                     | whole school        | unexplained |

To add a report: drop a new file in `reports/`, register it in `reports/registry.ts`.
Nothing else needs to change — `attendance-data.ts` derives every report's rows from the
same underlying dataset.

### Term-by-term status-group breakdown

A principal-facing report showing, for the whole school and each year level, the % of
teaching minutes in each status group (Present, the curated `STATUS_GROUPS` in
`api/compass-api.helpers.ts`, and Other) per term and year to date, with term-on-term
trends. It isn't a per-student roster, so it doesn't use the `ReportDefinition`/registry
machinery: it has its own pipeline (`status-group-report.ts`,
`email-templates/status-group-email-template.ts`, `send-status-group-report.ts`) and its
own schedule entry, `statusGroupReport`, in `config/cron-config.ts`.

## Scheduling

`cron.ts` registers two [`Deno.cron`](https://docs.deno.com/runtime/fundamentals/cron/)
jobs, controlled by `config/cron-config.ts`:

- **Daily job** (weekdays only) — runs the sync, then sends every enabled report, then the
  status-group breakdown. Report sends are skipped if the sync fails. The status-group
  report is wrapped in its own error handling so a failure there can't affect the
  per-student reports.
- **Evening discrepancy check** (weekly) — runs the 14-day trailing resync, then compares
  the DB's year-to-date `period_lines` count against Compass's own total. If the gap
  exceeds `DISCREPANCY_ESCALATION_THRESHOLD` it runs a full-year forced resync (can take
  hours). Silent when there's no gap; emails the sync summary recipients otherwise.

Settings:

- `runTimeLocal` — Melbourne local time (`"HH:MM"`, must land on a 5-minute mark) the
  daily job fires.
- `eveningCheckTimeLocal` / `eveningCheckDayLocal` — when the evening check fires (e.g.
  `21:00` on `Fri`). Weekly rather than nightly because a full-year resync the night
  before a report run previously caused an out-of-memory crash; Friday leaves the weekend
  to recover.
- `debugMode` / `debugRecipients` — read from `deno.env`'s `CRON_DEBUG_MODE` and
  `CRON_DEBUG_RECIPIENTS`, not committed to this file, since they differ per deployment.
  While `debugMode` is `true`, every report email is redirected to `debugRecipients`
  instead of its real recipients. Useful for testing the whole pipeline without
  coordinators receiving anything. The sync summary/failure email is unaffected by this
  flag — it always goes to `mail-config.ts`'s `syncSummaryRecipients`.
- `reports` — one entry per report id, with an `enabled` switch and its real `recipients`
  list.
- `statusGroupReport` — `enabled` switch and `recipients` for the status-group breakdown.

**Why a 5-minute tick instead of a normal cron expression:** `Deno.cron` schedules are
UTC-only with no timezone parameter. Baking Melbourne's UTC offset into a fixed cron
expression would drift an hour at every AEST/AEDT changeover, so instead the job ticks
every 5 minutes and only actually runs when the current Melbourne wall-clock time matches
`runTimeLocal` — correct year-round with no manual adjustment.

Two things worth knowing about `Deno.cron` in general:

- **No overlap** — if a run is still going when the next tick arrives, that tick is
  silently skipped (not queued).
- **No catch-up** — schedule state lives in-memory in the process. If the container isn't
  running at the scheduled moment (a host reboot, a deliberate restart), that day's run
  simply doesn't happen; nothing backfills it.

## Logging

`logger.ts` writes every log line to both stdout (visible via `docker compose logs`) and a
timestamped file under `logs/` (gitignored, created on first run). Both `sync.ts`'s own
CLI entry point and `cron.ts`'s daily job wrap themselves in a run — `sync.ts` produces
`logs/sync-<timestamp>.log`, `cron.ts` produces `logs/cron-daily-<timestamp>.log` covering
the sync **and** every report send that follows it in the same file, and the evening check
produces `logs/cron-evening-check-<timestamp>.log`. Every Compass API response (including
each page of the paginated period-lines fetch, with a running `fetched X/Y (Z%)` progress
indicator) is logged as it happens, not just at the end of a run. The sync summary/failure
email also includes the log file's path for that run. Files older than 30 days are pruned
automatically at the start of each run, so `logs/` doesn't grow unbounded.

## Configuration files

- `config/config.ts` — term/semester/year date ranges for the current school year.
- `config/mail-config.ts` — SMTP settings and `syncSummaryRecipients` (who gets the sync
  run summary/failure email).
- `config/cron-config.ts` — see [Scheduling](#scheduling) above.
- `check-env.ts` — the list of required `deno.env` variables.

## Database

Schema lives in `init/postgres-init.sh`, applied automatically **only** when the Postgres
data volume is first created. Schema changes after that need applying by hand against the
running container (`docker compose exec postgres psql -U postgres -d docker`).

| Table          | Contents                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `period_lines` | Raw per-period attendance rows synced from Compass.                                                                                                 |
| `statuses`     | Compass's attendance status reference list (full refresh every sync).                                                                               |
| `students`     | Cached student roster — name, code, year level (full refresh every sync). Report generation reads names from here rather than calling Compass live. |
| `sync_state`   | Single-row watermark of the last successfully completed sync.                                                                                       |

## Reference data

`csv/` and `models/` hold historical CSV exports and sample raw API response shapes
gathered while reverse-engineering the Compass endpoints. Not read by any script — kept
for reference only.

## Development

```
deno fmt      # 2-space, no semicolons, single quotes (see deno.json)
deno check    # type-check
```

Run both inside the container to match the pinned Deno version:
`docker compose run --rm web deno fmt` / `deno check <files>`.
