#!/usr/bin/env bash
# Interim Monday payroll email, until the new system runs in production.
# chris's crontab runs this at 12:00 and 13:00 UTC on Mondays; it acts once, at
# 8 AM Eastern (whichever of the two that is, daylight saving or not):
#   1. fresh production backup (the nightly 2:20 UTC one is taken before Rezku's
#      11:01 PM Eastern labour report, so it misses Sunday),
#   2. staging refreshed from it,
#   3. last week's Corner Deli payroll built on staging and emailed to the owner.
# FORCE=1 runs regardless of the time (still once per week unless the marker is removed).
set -Eeuo pipefail
readonly APP=/opt/corner-ops/runtime STAGING=/opt/corner-ops/staging
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [[ "${FORCE:-}" != 1 ]]; then
  [[ "$(TZ=America/New_York date +%a)" == Mon && "$(TZ=America/New_York date +%H)" == 08 ]] || exit 0
fi
# Last week's Monday (the script runs on Mondays; with FORCE on another day, the Monday before last).
week="$(TZ=America/New_York date -d "$(TZ=America/New_York date +%F) -$(( ($(TZ=America/New_York date +%u) + 6) % 7 + 7 )) days" +%F)"
marker="$STAGING/.payroll-preview-$week.sent"
[[ -e "$marker" ]] && { log "Already sent for $week."; exit 0; }

log "Payroll preview for week $week"
/bin/sh /opt/corner-ops/production/backup_prod.sh
"$APP/deploy/staging/refresh-staging.sh"
python3 "$APP/deploy/staging/monday-payroll-preview.py" --week "$week"
touch "$marker"
