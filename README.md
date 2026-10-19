# compass-reporting

Pulls student attendance data from the [Compass Education](https://www.compass.education/)
API for the configured school into Postgres, and generates/emails attendance-anomaly
reports (e.g. "students below 85% explained attendance") to year level coordinators —
either on demand or on an unattended daily schedule. It also sends a principal-facing
term-by-term attendance breakdown (whole school and per year level).

## Running tasks

Every task runs inside the `web` container. `./run.sh` is the short way to run one:

```
./run.sh <task> [args...]
```

It's the same as `docker compose run --rm web deno task <task> [args...]`, except that it
skips starting Postgres for the tasks that don't need it, and it refuses to start a second
copy of the scheduler. `./run.sh` on its own lists every task.

### Quick checks

Confirm a deployment is configured correctly, without waiting for the schedule or needing
any attendance data:

```
./run.sh check-env                  # are all required deno.env variables present?
./run.sh test-mail you@example.com  # can it send email?
```

`test-mail` prints the settings it's using (never the password), then the mail server's
response: an acceptance line such as `250 2.0.0 OK …` and `test-mail.ts: OK` on success,
or the server's error and `test-mail.ts: FAILED` otherwise. With no address it sends to
`SYNC_SUMMARY_RECIPIENTS`. It only needs the `MAIL_*` variables and
`SYNC_SUMMARY_RECIPIENTS`, so it works before the rest of `deno.env` is filled in.

### All tasks

| Command                                        | Needs Postgres | Purpose                                                                                                                                                                       |
| ---------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./run.sh check-env`                           | no             | Checks `deno.env` has every required variable, without running anything else.                                                                                                 |
| `./run.sh test-mail [email...]`                | no             | Sends a short test email with the `MAIL_*` settings, to the given addresses or `SYNC_SUMMARY_RECIPIENTS`.                                                                     |
| `./run.sh query <name> [args...]`              | no             | Pulls raw data straight from a Compass endpoint, bypassing Postgres. `./run.sh query` lists the available queries.                                                            |
| `./run.sh sync`                                | yes            | Syncs statuses, the student roster and period lines from Compass into Postgres now, then emails a run summary or failure alert to `SYNC_SUMMARY_RECIPIENTS`.                  |
| `./run.sh evening-check`                       | yes            | Runs the evening discrepancy check once: trailing resync, row-count check, and a full-year resync only if the gap exceeds `DISCREPANCY_ESCALATION_THRESHOLD`.                 |
| `./run.sh report`                              | yes            | Writes a CSV and a console table per registered report. No email.                                                                                                             |
| `./run.sh email-preview [report-id]`           | yes            | Renders one report's email to `email-templates/preview-<id>.html` for viewing in a browser, without sending anything.                                                         |
| `./run.sh send-report <report-id> [email...]`  | yes            | Sends one report by id. With addresses, it goes only to them, which is handy for testing against yourself.                                                                    |
| `./run.sh send-status-group-report <email...>` | yes            | Sends the term-by-term breakdown to the given addresses. Use `--preview` instead of addresses to write `email-templates/preview-status-group-breakdown.html` without sending. |

`sync` and `send-*` act for real: `sync` emails the summary recipients, and the `send-*`
tasks email whoever you name. `CRON_DEBUG_MODE` only redirects the scheduled sends.

The scheduler itself (`deno task cron`) is what the `web` container runs continuously.
Start it with `docker compose up -d` and watch it with `docker compose logs -f web`;
`./run.sh cron` refuses to start a second copy, which would run every job twice.

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
- Your school's Compass host (`COMPASS_SCHOOL_URL`) and a Compass API key
  (`COMPASS_API_KEY`)
- An SMTP account to send from (e.g. Gmail, via an app password)

## Setup

1. Create two gitignored env files in the project root, `.env` and `deno.env`, using the
   variables listed in [Environment variables](#environment-variables) below. Then check
   them:

   ```
   ./run.sh check-env
   ```

   Every entry point also runs this check first, so a missing variable stops the app at
   startup and the error lists **every** missing variable at once. Set
   `CRON_DEBUG_MODE=true` on any dev copy.

2. `docker compose up -d`: brings up Postgres and the `web` container running `cron.ts`.
   The schema is created from `init/postgres-init.sh` on Postgres's first boot only.

3. The first sync is a full backfill from the start of `TERM_1` and takes several hours
   (about 640,000 period lines took roughly 5 hours, at around 2,000 rows a minute). Every
   sync after that is incremental. It can be run by hand with `./run.sh sync`, and if it's
   interrupted it resumes where it stopped. See [Scheduling](#scheduling).

## Environment variables

### `.env`

Read by `docker-compose.yaml` only.

| Variable      | Required | Example               | Purpose                                                                         |
| ------------- | -------- | --------------------- | ------------------------------------------------------------------------------- |
| `HOST_UID`    | yes      | `1000`                | User id the `web` container runs as, so files it writes (logs, CSVs) are yours. |
| `HOST_GID`    | yes      | `1000`                | Group id for the same.                                                          |
| `PG_PORT`     | yes      | `5434`                | Host port Postgres is published on (inside Docker it's always 5432).            |
| `PG_USER`     | yes      | `postgres`            | Postgres superuser name.                                                        |
| `PG_PASSWORD` | yes      | `<postgres password>` | Postgres superuser password. Must match the one in `DB_URL`.                    |
| `TZ`          | no       | `Australia/Melbourne` | Not used. Harmless to keep.                                                     |

### `deno.env`

Read by the app inside the container, via `--env-file`. "Required" means `check-env` or
the app refuses to start without it.

**School**

| Variable              | Required | Example                                  | Purpose                                                                                                                                                                                                                          |
| --------------------- | -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPASS_SCHOOL_URL`  | yes      | `yourschool.compass.education`           | The host you log in to Compass at. A full URL like `https://yourschool.compass.education/` also works. Anything with a path after the host is rejected.                                                                          |
| `COMPASS_API_KEY`     | yes      | `<compass api key>`                      | Compass API key.                                                                                                                                                                                                                 |
| `SCHOOL_TIMEZONE`     | yes      | `Australia/Melbourne`                    | IANA timezone name (not an abbreviation like `AEST`, which has no daylight saving). Decides the school's local day and time everywhere: when cron jobs fire, the sync window, and how period lines are grouped into school days. |
| `SCHOOL_LOGO_URL`     | no       | `https://www.yourschool.edu.au/logo.png` | Logo shown top-right in every report email. Must be a public http(s) image URL, because email clients fetch it when the email is opened. Shown 154px wide, height follows the image. No logo if unset.                           |
| `TERM_1`, `TERM_2`, … | `TERM_1` | `2026-01-27,2026-04-02`                  | The school year's terms, each `<start>,<end>` as `YYYY-MM-DD`, both days included. See [Term dates](#term-dates).                                                                                                                |
| `TZ`                  | no       | `Australia/Melbourne`                    | Not needed: the app uses `SCHOOL_TIMEZONE` for everything school-related. Harmless to keep.                                                                                                                                      |

**Database**

| Variable | Required | Example                                                        | Purpose                                                                           |
| -------- | -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `DB_URL` | yes      | `postgres://postgres:<postgres password>@postgres:5432/docker` | Connection string. User and password must match `.env`'s `PG_USER`/`PG_PASSWORD`. |

**Email**

| Variable                  | Required             | Example               | Purpose                                                                                                         |
| ------------------------- | -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `MAIL_HOST`               | yes                  | `smtp.gmail.com`      | SMTP server every email is sent through.                                                                        |
| `MAIL_PORT`               | yes                  | `465`                 | SMTP port.                                                                                                      |
| `MAIL_SECURITY`           | yes                  | `tls`                 | Exactly `tls`, `starttls` or `none`. See [Mail security](#mail-security).                                       |
| `MAIL_FROM`               | yes                  | `noreply@example.com` | From address on every email.                                                                                    |
| `MAIL_USERNAME`           | no                   | `noreply@example.com` | SMTP login. Leave out for a server that accepts mail without one.                                               |
| `MAIL_PASSWORD`           | with `MAIL_USERNAME` | `<smtp app password>` | SMTP password. Set both login variables or neither. A login can't be combined with `MAIL_SECURITY=none`.        |
| `SYNC_SUMMARY_RECIPIENTS` | yes                  | `you@example.com`     | Comma-separated. Who gets the sync summary/failure and evening-check emails. Not affected by `CRON_DEBUG_MODE`. |

**Schedule and reports**

| Variable                           | Required                    | Example                                         | Purpose                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRON_DEBUG_MODE`                  | yes                         | `false`                                         | Exactly `true` or `false`. While `true`, every report email goes to `CRON_DEBUG_RECIPIENTS` instead of its real recipients. Required, not defaulted, so a misconfigured copy can't email real coordinators. |
| `CRON_DEBUG_RECIPIENTS`            | when `CRON_DEBUG_MODE=true` | `you@example.com`                               | Comma-separated. Where report emails go in debug mode.                                                                                                                                                      |
| `DISCREPANCY_ESCALATION_THRESHOLD` | yes                         | `500`                                           | Non-negative integer. The smallest positive DB-vs-Compass row gap the weekly evening check will fix with a full-year resync. Smaller gaps are just reported. See [Scheduling](#scheduling).                 |
| `REPORT_ENABLED_<REPORT_ID>`       | yes, one per report         | `true`                                          | Exactly `true` or `false`: whether that report goes out on the daily schedule. See [Report variables](#report-variables).                                                                                   |
| `REPORT_RECIPIENTS_<REPORT_ID>`    | when that report is enabled | `coordinator@example.com,principal@example.com` | Comma-separated. Who receives that report on the daily schedule.                                                                                                                                            |

#### Term dates

`TERM_1`, `TERM_2`, … are read in order until the first missing number, so a school with
three or four terms just sets three or four. Each term must start after the previous one
ends, and the numbers can't have gaps (a `TERM_3` with no `TERM_2` is an error). The year
runs from the first term's start to the last term's end. Update them at the start of each
school year.

#### Mail security

- `tls`: encrypted from the start, usually port 465. Prefer this where your provider
  offers it, because denomailer's STARTTLS handling on port 587 has a known bug.
- `starttls`: connects unencrypted, then upgrades. Usually port 587 or 25. Fails if the
  server doesn't offer STARTTLS.
- `none`: no encryption required, e.g. an internal relay on port 25. STARTTLS is still
  used if the server offers it.

#### Report variables

Each report's variables are named after its id upper-cased, with `-` turned into `_`. The
term-by-term breakdown has its own fixed id, `status-group-breakdown`. With the current
reports, that means these variables:

| Report                       | Switch (always required)                    | Recipients (required when the switch is `true`) |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------- |
| `unexplained-absences`       | `REPORT_ENABLED_UNEXPLAINED_ABSENCES`       | `REPORT_RECIPIENTS_UNEXPLAINED_ABSENCES`        |
| `explained-absences`         | `REPORT_ENABLED_EXPLAINED_ABSENCES`         | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES`          |
| `explained-absences-year-7`  | `REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_7`  | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_7`   |
| `explained-absences-year-8`  | `REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_8`  | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_8`   |
| `explained-absences-year-9`  | `REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_9`  | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_9`   |
| `explained-absences-year-10` | `REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_10` | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_10`  |
| `explained-absences-year-11` | `REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_11` | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_11`  |
| `explained-absences-year-12` | `REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_12` | `REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_12`  |
| `status-group-breakdown`     | `REPORT_ENABLED_STATUS_GROUP_BREAKDOWN`     | `REPORT_RECIPIENTS_STATUS_GROUP_BREAKDOWN`      |

Keeping the switch separate from the recipients means you can turn a report off and back
on without touching its addresses. A disabled report can still be sent by hand with
`send-report`. `cron.ts` refuses to start if a `REPORT_ENABLED_*` or `REPORT_RECIPIENTS_*`
name doesn't match any report (the error lists the valid names), or if an enabled report
has no recipients. Adding a new report to the registry means adding its `REPORT_ENABLED_*`
line to every deployment's `deno.env`.

### Example `deno.env`

```
COMPASS_SCHOOL_URL=yourschool.compass.education
COMPASS_API_KEY=<compass api key>
SCHOOL_TIMEZONE=Australia/Melbourne
SCHOOL_LOGO_URL=https://www.yourschool.edu.au/logo.png
TERM_1=2026-01-27,2026-04-02
TERM_2=2026-04-20,2026-06-26
TERM_3=2026-07-13,2026-09-18
TERM_4=2026-10-05,2026-12-18

DB_URL=postgres://postgres:<postgres password>@postgres:5432/docker

MAIL_HOST=smtp.gmail.com
MAIL_PORT=465
MAIL_SECURITY=tls
MAIL_FROM=noreply@example.com
MAIL_USERNAME=noreply@example.com
MAIL_PASSWORD=<smtp app password>
SYNC_SUMMARY_RECIPIENTS=you@example.com

CRON_DEBUG_MODE=true
CRON_DEBUG_RECIPIENTS=you@example.com
DISCREPANCY_ESCALATION_THRESHOLD=500

REPORT_ENABLED_UNEXPLAINED_ABSENCES=false
REPORT_ENABLED_EXPLAINED_ABSENCES=false
REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_7=true
REPORT_RECIPIENTS_EXPLAINED_ABSENCES_YEAR_7=coordinator@example.com,principal@example.com
REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_8=false
REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_9=false
REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_10=false
REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_11=false
REPORT_ENABLED_EXPLAINED_ABSENCES_YEAR_12=false
REPORT_ENABLED_STATUS_GROUP_BREAKDOWN=true
REPORT_RECIPIENTS_STATUS_GROUP_BREAKDOWN=principal@example.com
```

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

To add a report: drop a new file in `reports/`, register it in `reports/registry.ts`. No
other code needs to change — `attendance-data.ts` derives every report's rows from the
same underlying dataset. Then add its `REPORT_ENABLED_<REPORT_ID>` (and, when `true`,
`REPORT_RECIPIENTS_<REPORT_ID>`) to every deployment's `deno.env`. The switch is required,
so `check-env` and `cron.ts` fail until it's there.

### Term-by-term status-group breakdown

A principal-facing report showing, for the whole school and each year level, the % of
teaching minutes in each status group (Present, the curated `STATUS_GROUPS` in
`api/compass-api.helpers.ts`, and Other) per term and year to date, with term-on-term
trends. It isn't a per-student roster, so it doesn't use the `ReportDefinition`/registry
machinery: it has its own pipeline (`status-group-report.ts`,
`email-templates/status-group-email-template.ts`, `send-status-group-report.ts`) and its
own variables, `REPORT_ENABLED_STATUS_GROUP_BREAKDOWN` and
`REPORT_RECIPIENTS_STATUS_GROUP_BREAKDOWN`. It shows one column per configured term.

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

- `runTimeLocal` — school-local time (`"HH:MM"` in `SCHOOL_TIMEZONE`, must land on a
  5-minute mark) the daily job fires.
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
- `reports` / `statusGroupReport` — built from `deno.env`'s `REPORT_ENABLED_*` and
  `REPORT_RECIPIENTS_*` variables (see [Report variables](#report-variables)). `cron.ts`
  logs the scheduled reports at startup.

**Why a 5-minute tick instead of a normal cron expression:** `Deno.cron` schedules are
UTC-only with no timezone parameter. Baking the school's UTC offset into a fixed cron
expression would drift an hour at every daylight-saving changeover, so instead the job
ticks every 5 minutes and only actually runs when the current wall-clock time in
`SCHOOL_TIMEZONE` matches `runTimeLocal` — correct year-round with no manual adjustment.

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

- `config/config.ts` — reads and validates the term dates (`TERM_n`) from `deno.env` and
  derives the year's date range.
- `config/mail-config.ts` — reads and validates the SMTP settings (`MAIL_*`) and
  `SYNC_SUMMARY_RECIPIENTS` (who gets the sync run summary/failure email) from `deno.env`.
- `config/cron-config.ts` — schedule times, debug mode, and the per-report switches and
  recipients from `deno.env`. See [Scheduling](#scheduling) above.
- `config/report-env-keys.ts` — the `REPORT_ENABLED_*` / `REPORT_RECIPIENTS_*` variable
  names for each report.
- `config/timezone.ts` — reads and validates `SCHOOL_TIMEZONE`.
- `config/logo.ts` — reads and validates `SCHOOL_LOGO_URL`.
- `check-env.ts` — the list of required `deno.env` variables.

Every variable is described in [Environment variables](#environment-variables).

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
