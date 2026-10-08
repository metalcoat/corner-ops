#!/usr/bin/env bash
# Calls one of the app's scheduled jobs with CRON_SECRET from /opt/corner-ops/.env.
#   deploy/run-cron.sh ordering-maintenance | schedule-delivery | scheduler | missed-clock-outs
set -Eeuo pipefail

readonly ENV_FILE="${CORNER_OPS_ROOT:-/opt/corner-ops}/.env"
case "${1:-}" in
  ordering-maintenance) path="ordering-maintenance" ;;
  schedule-delivery) path="schedule-delivery" ;;
  scheduler) path="scheduler-0700" ;; # runs the 3 AM Eastern daily scheduler; it skips other hours
  missed-clock-outs) path="missed-clock-outs" ;; # every 15 minutes; each open punch is handled once
  *) printf 'Usage: %s ordering-maintenance|schedule-delivery|scheduler|missed-clock-outs\n' "$0" >&2; exit 64 ;;
esac

secret="$(grep -E '^[[:space:]]*(export[[:space:]]+)?CRON_SECRET[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- \
  | sed -E -e 's/\r$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'$/\1/" || true)"
if [[ -z "$secret" ]]; then
  printf '%s CRON_SECRET is not set in %s; scheduled jobs cannot run.\n' "$(date -u +%FT%TZ)" "$ENV_FILE" >&2
  exit 1
fi

# The secret goes in through a file descriptor so it never appears in the process list.
curl -fsS --max-time 300 -H @<(printf 'Authorization: Bearer %s\n' "$secret") "http://127.0.0.1:3000/api/cron/${path}"
echo
