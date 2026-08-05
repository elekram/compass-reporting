# compass-reporting

Pulls student attendance data from the [Compass Education](https://www.compass.education/)
API for Cheltenham Secondary College into Postgres, and generates/emails
attendance-anomaly reports (e.g. "students below 85% explained attendance") to year level
coordinators — either on demand or on an unattended daily schedule.

## How it fits together

```
Compass API  →  sync.ts        →  Postgres (period_lines, statuses, students)
                                        │
                                        ▼
                            attendance-data.ts (shaping/filtering/trends)
                                        │
                                        ▼
                        email-templates/email-template.ts (HTML)
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
   ```

2. `docker compose up -d` — brings up Postgres (schema created from
   `init/postgres-init.sh` on first boot only) and the `web` container running `cron.ts`.

3. The first sync is a full historical backfill (from `config.year.start`) and can take a
   while; every sync after that is incremental. See [Scheduling](#scheduling).

## Tasks

All tasks run via `docker compose run --rm web deno task <name> [-- args]`.

| Task            | Command                                           | Purpose                                                                                                                                                   |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`          | `deno task sync`                                  | One-shot sync: statuses, student roster, and period lines from Compass into Postgres. Emails a run summary/failure alert (see `config/mail-config.ts`).   |
| `report`        | `deno task report`                                | Writes a CSV + console table per registered report — no email.                                                                                            |
| `email-preview` | `deno task email-preview -- [report-id]`          | Renders one report's email to `email-templates/preview-<id>.html` for viewing in a browser, without sending anything.                                     |
| `send-report`   | `deno task send-report -- <report-id> [email...]` | Sends one report by id. Extra args override its configured recipients — handy for testing against yourself.                                               |
| `cron`          | `deno task cron`                                  | Registers the daily scheduled job and keeps running (this is what the `web` container runs continuously).                                                 |
| `query`         | `deno task query -- <name> [args...]`             | Ad-hoc CLI for pulling raw data straight from a Compass endpoint (bypasses Postgres entirely) — see `compass-query.ts` for the list of available queries. |

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

## Scheduling

`cron.ts` registers one [`Deno.cron`](https://docs.deno.com/runtime/fundamentals/cron/)
job that runs the sync and then sends every enabled report, controlled by
`config/cron-config.ts`:

- `runTimeLocal` — Melbourne local time (`"HH:MM"`, must land on a 5-minute mark) the job
  fires.
- `debugMode` / `debugRecipients` — while `debugMode` is `true`, every report email is
  redirected to `debugRecipients` instead of its real recipients. Useful for testing the
  whole pipeline without coordinators receiving anything. The sync summary/failure email
  is unaffected by this flag — it always goes to `mail-config.ts`'s
  `syncSummaryRecipients`.
- `reports` — one entry per report id, with an `enabled` switch and its real `recipients`
  list.

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

## Configuration files

- `config/config.ts` — term/semester/year date ranges for the current school year.
- `config/mail-config.ts` — SMTP settings and `syncSummaryRecipients` (who gets the sync
  run summary/failure email).
- `config/cron-config.ts` — see [Scheduling](#scheduling) above.

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
