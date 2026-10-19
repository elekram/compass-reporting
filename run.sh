#!/bin/sh
# shorthand for running a deno.json task inside the web container:
#   ./run.sh <task> [args...]
# is the same as
#   docker compose run --rm [--no-deps] web deno task <task> [args...]
# with --no-deps added for the tasks that never touch Postgres, so they don't
# start (or wait on) the database. Run with no arguments for the task list.
set -eu

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: ./run.sh <task> [args...]

Checks (no database needed):
  check-env                         check deno.env has every required variable
  test-mail [email...]              send a test email (default: SYNC_SUMMARY_RECIPIENTS)
  query <name> [args...]            raw data straight from a Compass endpoint
                                    e.g. query period-lines 2026-07-01 2026-08-01

Sync:
  sync                              sync Compass into Postgres now, then email a summary
  evening-check                     run the weekly discrepancy check now

Reports:
  report                            write a CSV + console table per report (no email)
  email-preview [report-id]         render a report email to email-templates/preview-<id>.html
  send-report <report-id> [email...]  send one report (to the given addresses if any)
  send-status-group-report <email...> | --preview
                                    send (or preview) the term-by-term breakdown
EOF

  # read from the source each time rather than listed here, so a newly added
  # report or query shows up without anyone remembering to edit this script.
  echo
  echo "Report ids (for email-preview and send-report):"
  grep -h "^  id: '" reports/*.ts | sed -E "s/^  id: '([^']+)'.*/  \1/" | sort -V
  echo
  echo "Queries (for query):"
  awk '/^const QUERIES/ { f = 1; next } f && /^}/ { f = 0 } f' compass-query.ts |
    grep -oE "^  '?[a-z-]+'?:" | tr -d " ':" | sed 's/^/  /'

  cat <<'EOF'

The scheduler (cron) runs in the web container: start it with `docker compose up -d`.
EOF
}

if [ $# -eq 0 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ "$1" = "help" ]; then
  usage
  exit 0
fi

task=$1
shift

case "$task" in
  check-env | test-mail | query)
    deps="--no-deps"
    ;;
  sync | evening-check | report | email-preview | send-report | send-status-group-report)
    deps=""
    ;;
  cron)
    # a second copy alongside the web container's own would run every
    # scheduled job twice — two syncs at once, and every report sent twice.
    echo "cron already runs in the web container — use \`docker compose up -d\` to start it" >&2
    echo "and \`docker compose logs -f web\` to watch it." >&2
    exit 1
    ;;
  *)
    echo "Unknown task: $task" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac

# shellcheck disable=SC2086 # $deps is deliberately unquoted: empty or one flag
exec docker compose run --rm $deps web deno task "$task" "$@"
