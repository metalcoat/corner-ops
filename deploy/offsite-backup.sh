#!/usr/bin/env bash
# Nightly off-site copy of the store server's backups to Google Drive,
# encrypted before upload (rclone "crypt" remote; Google sees only scrambled
# names and contents). Runs from chris's crontab after the dev backup
# (07:30 UTC); the production backup runs at 02:20 UTC.
#
# Uploads, into <remote>/nightly/<UTC date>/:
#   - the newest production database dump and uploads archive
#   - the newest dev database dump and uploads archive
#   - secrets-<stamp>.tar.gz: the production, staging and dev .env files and
#     /opt/corner-ops/config (needed to decrypt employment forms and sessions
#     after a restore)
# and deletes nightly folders older than KEEP_DAYS.
#
# Remotes live in ~/.config/rclone/rclone.conf: "gdrive" (Google Drive,
# drive.file scope) and "cornerops-offsite" (crypt over gdrive). The crypt
# passwords must also be kept in the owner's password manager: without them
# the Drive copies cannot be read.
#
# Restore: rclone copy cornerops-offsite:nightly/<date> ./restore  (then
# pg_restore the dump; see deploy/restore-db.sh for dev).
set -Eeuo pipefail
umask 077

readonly RCLONE="${RCLONE:-/home/chris/.local/bin/rclone}"
readonly REMOTE="${CORNER_OPS_OFFSITE_REMOTE:-cornerops-offsite:}"
readonly KEEP_DAYS="${CORNER_OPS_OFFSITE_KEEP_DAYS:-30}"
readonly ROOT=/opt/corner-ops
readonly STATE_DIR=/home/chris/.local/state
readonly LOCK_FILE="${STATE_DIR}/offsite-backup.lock"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
newest() { find "$1" -maxdepth 1 -type f -name "$2" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-; }

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "Another off-site backup is running; exiting."; exit 0; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
day="$(date -u +%F)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for pattern in \
  "$ROOT/production/backups|cornerops-*.dump" \
  "$ROOT/production/backups|uploads-*.tar.gz" \
  "$ROOT/backups|cornerops-db-*.dump" \
  "$ROOT/backups|cornerops-uploads-*.tar.gz"; do
  file="$(newest "${pattern%%|*}" "${pattern#*|}")"
  if [[ -z "$file" ]]; then log "Missing backup for ${pattern}"; exit 1; fi
  # A backup older than two days means the nightly job itself is failing.
  if [[ -n "$(find "$file" -mmin +2880)" ]]; then log "Stale backup: $file"; exit 1; fi
  case "$file" in
    "$ROOT/production/"*) ln -s "$file" "$work/production-$(basename "$file")" ;;
    *) ln -s "$file" "$work/dev-$(basename "$file")" ;;
  esac
done

secrets=()
for path in "$ROOT/production/.env" "$ROOT/staging/.env" "$ROOT/.env" "$ROOT/config"; do
  [[ -e "$path" ]] && secrets+=("${path#/}")
done
tar -C / -czf "$work/secrets-${stamp}.tar.gz" "${secrets[@]}"

"$RCLONE" copy --copy-links --transfers 2 --retries 5 --low-level-retries 10 \
  "$work" "${REMOTE}nightly/${day}"

# Read back what landed before pruning anything.
uploaded="$("$RCLONE" lsf "${REMOTE}nightly/${day}" | wc -l)"
expected="$(find "$work" -mindepth 1 -maxdepth 1 | wc -l)"
if (( uploaded < expected )); then log "Only ${uploaded} of ${expected} files reached Drive."; exit 1; fi

"$RCLONE" delete --min-age "${KEEP_DAYS}d" "${REMOTE}nightly" || log "Pruning old copies failed (will retry tomorrow)."
"$RCLONE" rmdirs --leave-root "${REMOTE}nightly" || true

date -u +%FT%TZ > "${STATE_DIR}/offsite-backup.last-success"
log "Off-site backup ${day}: ${uploaded} files ($(du -shL "$work" | cut -f1)) uploaded."
