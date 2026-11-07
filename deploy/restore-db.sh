#!/usr/bin/env bash
# Restore the Corner Ops database from a backup made by backup-db.sh.
#   deploy/restore-db.sh /opt/corner-ops/backups/cornerops-db-YYYYMMDDTHHMMSSZ.dump
# Takes a fresh safety backup first, stops the app, restores, and restarts it.
set -Eeuo pipefail

readonly DUMP="${1:-}"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  printf 'Usage: %s <cornerops-db-*.dump>\n' "$0" >&2
  exit 64
fi
if [[ "$(id -u)" == "0" ]]; then
  log "Refusing to run as root; run as chris."
  exit 1
fi
docker exec -i corner-ops-postgres pg_restore --list < "$DUMP" > /dev/null

printf 'This replaces ALL current Corner Ops data with %s.\nType RESTORE to continue: ' "$(basename "$DUMP")"
read -r answer
[[ "$answer" == "RESTORE" ]] || { log "Cancelled."; exit 1; }

log "Taking a safety backup of the current data first."
"$(dirname "$0")/backup-db.sh"

log "Stopping the app so nothing writes during the restore."
docker stop corner-ops-app >/dev/null
trap 'docker start corner-ops-app >/dev/null; log "App restarted."' EXIT
docker exec -i corner-ops-postgres pg_restore -U cornerops -d cornerops --clean --if-exists --no-owner --single-transaction < "$DUMP"
log "Restore complete."
