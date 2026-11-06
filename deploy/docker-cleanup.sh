#!/usr/bin/env bash
# Daily Docker cleanup for the shared box (dev, staging and production all run here; the disk got down to
# 1.6 GB free on 2026-11-06). update.sh only prunes after a deploy, and only untagged images and old build
# cache, so tagged leftovers piled up. This removes only:
#   - untagged images,
#   - build cache beyond 5 GB,
#   - corner-ops-* tags no container uses, older than 14 days, except :latest, :rollback and :before-* (rollback points).
# It never touches containers, volumes, Postgres data, base images (postgres, alpine, golang, ...) or anything in use.
# Installed in chris's crontab (04:40 daily). Run by hand: deploy/docker-cleanup.sh   (--dry-run lists only;
# --test-alert only sends the low-disk email once so its delivery can be checked).
# Under 8 GB free it emails the owner (deploy/send-alert-email.py, the app's SMTP settings) at most once a day.
set -uo pipefail
DRY_RUN=false
TEST_ALERT=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
[[ "${1:-}" == "--test-alert" ]] && TEST_ALERT=true

readonly LOG_DIR="/opt/corner-ops/deploy/logs"
readonly STATE_DIR="/opt/corner-ops/deploy/state"
readonly KEEP_DAYS=14
readonly LOW_DISK_GB=8
readonly HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$LOG_DIR" "$STATE_DIR"
$DRY_RUN || exec >>"$LOG_DIR/docker-cleanup.log" 2>&1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
free_gb() { df -BG --output=avail / | tail -1 | tr -dc '0-9'; }

before="$(free_gb)"
if $TEST_ALERT; then
  :
elif $DRY_RUN; then
  log "Dry run: would prune $(docker images -f dangling=true -q | wc -l) untagged images and build cache beyond 5 GB ($(docker system df --format '{{.Type}} {{.Size}}' | grep -i 'build cache'))."
else
  docker image prune -f >/dev/null || log "WARNING: image prune failed."
  docker builder prune -f --keep-storage 5GB >/dev/null || log "WARNING: builder prune failed."
fi

used="$(docker ps -aq | xargs -r docker inspect --format '{{.Image}}')"
cutoff="$(date -d "${KEEP_DAYS} days ago" +%s)"
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' | while read -r ref id; do
  repo="${ref%%:*}" tag="${ref##*:}"
  [[ "$repo" == corner-ops-* ]] || continue
  [[ "$tag" == latest || "$tag" == rollback || "$tag" == before-* || "$tag" == "<none>" ]] && continue
  grep -qF "$id" <<<"$used" && continue
  created="$(date -d "$(docker image inspect --format '{{.Created}}' "$id")" +%s 2>/dev/null || echo 0)"
  (( created > 0 && created < cutoff )) || continue
  $TEST_ALERT && continue
  if $DRY_RUN; then log "Dry run: would remove unused old image ${ref}."; else docker rmi "$ref" >/dev/null && log "Removed unused old image ${ref}."; fi
done

after="$(free_gb)"
$DRY_RUN || printf '%s\n' "$after" >"$STATE_DIR/disk_free_gb"
log "Disk free on /: ${before} GB -> ${after} GB."
alert_email() {
  {
    printf 'Only %s GB is free on the Corner Ops server disk (/). Dev, staging and production all share it;\n' "$1"
    printf 'when it fills, databases and deploys can fail.\n\n'
    python3 "$HERE/disk-usage-summary.py" 2>/dev/null || df -h /
  } | python3 "$HERE/send-alert-email.py" "Corner Ops server: only $1 GB disk free"
}

if $TEST_ALERT; then
  alert_email "$after" && log "Test low-disk email sent (${after} GB free)."
elif (( after < LOW_DISK_GB )); then
  log "WARNING: only ${after} GB free on / (dev, staging and production share this disk)."
  if ! $DRY_RUN && [[ "$(cat "$STATE_DIR/disk_alert_date" 2>/dev/null)" != "$(date -u +%F)" ]]; then
    alert_email "$after" && date -u +%F >"$STATE_DIR/disk_alert_date" && log "Low-disk email sent."
  fi
fi
