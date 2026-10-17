#!/usr/bin/env bash
# Nightly Corner Ops backup: a verified PostgreSQL dump plus the uploaded files
# (delivery photos, documents), kept for CORNER_OPS_BACKUP_KEEP_DAYS days and
# optionally copied off the box with rclone. Run as chris, never as root.
set -Eeuo pipefail

readonly ROOT_DIR="${CORNER_OPS_ROOT:-/opt/corner-ops}"
readonly ENV_FILE="${ROOT_DIR}/.env"

env_value() {
  # Read KEY=value from .env without executing it.
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

readonly BACKUP_DIR="$(env_value CORNER_OPS_BACKUP_DIR || true)"
readonly TARGET_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
KEEP_DAYS="$(env_value CORNER_OPS_BACKUP_KEEP_DAYS || true)"
KEEP_DAYS="${KEEP_DAYS:-30}"
readonly RCLONE_REMOTE="$(env_value CORNER_OPS_BACKUP_RCLONE_REMOTE || true)"

if [[ "$(id -u)" == "0" ]]; then
  log "Refusing to run as root; run as chris."
  exit 1
fi

umask 077
install -d -m 0700 "$TARGET_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
db_file="${TARGET_DIR}/cornerops-db-${stamp}.dump"
partial="${db_file}.partial"
trap 'rm -f "$partial"' EXIT

log "Dumping database."
docker exec corner-ops-postgres pg_dump -U cornerops -d cornerops --format=custom --compress=9 > "$partial"
# A dump that pg_restore cannot list is worthless; check before keeping it.
docker exec -i corner-ops-postgres pg_restore --list < "$partial" > /dev/null
mv "$partial" "$db_file"
log "Database backup: ${db_file} ($(du -h "$db_file" | cut -f1))."

uploads_file="${TARGET_DIR}/cornerops-uploads-${stamp}.tar.gz"
if docker exec corner-ops-app sh -c 'test -d /data/uploads' 2>/dev/null; then
  if docker exec corner-ops-app tar -czf - -C /data uploads > "${uploads_file}.partial" 2>/dev/null; then
    mv "${uploads_file}.partial" "$uploads_file"
    log "Uploads backup: ${uploads_file} ($(du -h "$uploads_file" | cut -f1))."
  else
    rm -f "${uploads_file}.partial"
    log "WARNING: uploads backup failed; the database backup is still good."
  fi
fi

find "$TARGET_DIR" -maxdepth 1 -type f -name 'cornerops-*' -mtime "+${KEEP_DAYS}" -print -delete | sed 's/^/Removed old backup: /'

if [[ -n "$RCLONE_REMOTE" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    log "Copying to ${RCLONE_REMOTE}."
    rclone copy "$db_file" "$RCLONE_REMOTE"
    [[ -f "$uploads_file" ]] && rclone copy "$uploads_file" "$RCLONE_REMOTE"
  else
    log "WARNING: CORNER_OPS_BACKUP_RCLONE_REMOTE is set but rclone is not installed; backup kept on this box only."
  fi
fi

date -u +%FT%TZ > "${TARGET_DIR}/last-success"
log "Backup complete."
