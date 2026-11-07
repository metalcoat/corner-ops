#!/usr/bin/env bash
# Daily Docker cleanup for the shared box (dev, staging and production all run here; the disk got down to
# 1.6 GB free on 2026-11-06). update.sh only prunes after a deploy, and only untagged images and old build
# cache, so tagged leftovers piled up. This removes only:
#   - untagged images,
#   - build cache beyond 5 GB,
#   - corner-ops-* tags no container uses, older than 14 days, except :latest, :rollback and :before-* (rollback points),
#   - stopped one-off containers (no restart policy, not prod/prodref) older than 7 days,
#   - npm/npx/pip cache files untouched for 7 days, deploy logs older than 30 days, and helper logs over 20 MB
#     (cut to their last 5000 lines).
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

# Everything below is re-creatable. Never: volumes, databases, backups, call/order records, rollback images.
SUMMARY=()
remove() {  # remove <what> <name> <command...> ; honours --dry-run and --test-alert
  $TEST_ALERT && return 0
  if $DRY_RUN; then log "Dry run: would remove $1 $2."; else "${@:3}" >/dev/null && log "Removed $1 $2."; fi
}

# Stopped one-off containers (no restart policy) older than 7 days. Never prod/prodref or compose services.
week_ago="$(date -d '7 days ago' +%s)"
docker ps -a --filter status=exited --format '{{.Names}}' | while read -r name; do
  [[ "$name" == *prod* || "$name" == corner-ops-* || "$name" == corner-deli-* ]] && continue
  [[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name")" =~ ^(no|)$ ]] || continue
  finished="$(date -d "$(docker inspect --format '{{.State.FinishedAt}}' "$name")" +%s 2>/dev/null || echo 0)"
  (( finished > 0 && finished < week_ago )) && remove "stopped container" "$name" docker rm "$name"
done

# Package caches in chris's home (re-downloaded on demand): files untouched for 7 days.
cache_mb() { du -sm "$HOME/.npm/_cacache" "$HOME/.npm/_npx" "$HOME/.cache/pip" 2>/dev/null | awk '{s+=$1} END {print s+0}'; }
cache_before="$(cache_mb)"
for dir in "$HOME/.npm/_cacache" "$HOME/.npm/_npx" "$HOME/.npm/_logs" "$HOME/.cache/pip"; do
  [[ -d "$dir" ]] || continue
  if $DRY_RUN; then
    log "Dry run: would remove $(find "$dir" -type f -mtime +7 | wc -l) files ($(find "$dir" -type f -mtime +7 -printf '%s\n' | awk '{s+=$1} END {printf "%.0f", s/1048576}') MB) older than 7 days from $dir."
  elif ! $TEST_ALERT; then
    find "$dir" -type f -mtime +7 -delete; find "$dir" -mindepth 1 -type d -empty -delete
  fi
done
$DRY_RUN || $TEST_ALERT || SUMMARY+=("package caches ${cache_before} MB -> $(cache_mb) MB")

# Old deploy logs (update.sh already drops its own after 7 days) and oversized helper logs.
find "$LOG_DIR" -type f -name '*.log' ! -name docker-cleanup.log -mtime +30 | while read -r file; do remove "old log" "$file" rm -f "$file"; done
for file in "$HOME"/.local/state/*.log; do
  [[ -f "$file" ]] && (( $(stat -c %s "$file") > 20971520 )) || continue
  remove "all but the last 5000 lines of" "$file" sh -c 'tail -n 5000 "$1" >"$1.tmp" && mv "$1.tmp" "$1"' _ "$file"
done

after="$(free_gb)"
$DRY_RUN || printf '%s\n' "$after" >"$STATE_DIR/disk_free_gb"
log "Disk free on /: ${before} GB -> ${after} GB.${SUMMARY:+ (${SUMMARY[*]})}"
alert_email() {
  {
    printf 'Only %s GB is free on the Corner Ops server disk (/). Dev, staging and production all share it;\n' "$1"
    printf 'when it fills, databases and deploys can fail.\n\n'
    python3 "$HERE/disk-usage-summary.py" 2>/dev/null || df -h /
    printf '\nLast nightly cleanups:\n'
    grep -E 'Disk free on /|Removed' "$LOG_DIR/docker-cleanup.log" 2>/dev/null | tail -8
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
