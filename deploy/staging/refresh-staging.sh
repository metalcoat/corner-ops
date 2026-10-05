#!/usr/bin/env bash
# Rebuilds staging: the given commit of this repo, on a fresh copy of last night's
# production backup (database and uploaded files). Production is only read (its
# backup files and settings); nothing in production is changed or stopped.
#
#   deploy/staging/refresh-staging.sh [git-ref]     (default: agent/pos-ordering-foundation)
#
# Staging answers on this box's deli-network address, port 3002, and nowhere else.
set -Eeuo pipefail

readonly REF="${1:-agent/pos-ordering-foundation}"
readonly SOURCE_REPO="/opt/corner-ops/app"
readonly STAGING="/opt/corner-ops/staging"
readonly BACKUPS="/opt/corner-ops/production/backups"
readonly COMPOSE_FILE="$SOURCE_REPO/deploy/staging/docker-compose.staging.yml"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

address="${STAGING_ADDRESS:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
if [[ ! "$address" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
  echo "Not a private network address ($address); set STAGING_ADDRESS." >&2
  exit 1
fi
export STAGING_ADDRESS="$address"

dump="$(ls -1 "$BACKUPS"/cornerops-2*.dump 2>/dev/null | sort | tail -n 1)"
uploads="$(ls -1 "$BACKUPS"/uploads-2*.tar.gz 2>/dev/null | sort | tail -n 1)"
[[ -n "$dump" && -n "$uploads" ]] || { echo "No production backup found in $BACKUPS." >&2; exit 1; }

mkdir -p "$STAGING"
exec 9>"$STAGING/.refresh.lock"
flock -n 9 || { echo "A staging refresh is already running." >&2; exit 1; }

log "Code: $REF"
if [[ ! -d "$STAGING/app/.git" ]]; then git clone --quiet "$SOURCE_REPO" "$STAGING/app"; fi
git -C "$STAGING/app" fetch --quiet "$SOURCE_REPO" "+refs/heads/*:refs/remotes/source/*"
sha="$(git -C "$SOURCE_REPO" rev-parse --verify "$REF^{commit}")"
git -C "$STAGING/app" checkout --quiet --detach "$sha"
log "Checked out $sha"

[[ -f "$STAGING/.env" ]] || python3 "$SOURCE_REPO/deploy/staging/make-staging-env.py" "$address"
compose=(docker compose --project-name corner-ops-staging --env-file "$STAGING/.env" -f "$COMPOSE_FILE")

log "Resetting staging's own database and files"
"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait postgres
log "Restoring $(basename "$dump")"
# Warnings (e.g. roles that only exist in production) don't stop the restore; the check below does.
docker exec -i corner-ops-staging-postgres pg_restore -U cornerops -d cornerops --no-owner --no-acl < "$dump" \
  2> "$STAGING/restore.log" || log "pg_restore finished with warnings (see $STAGING/restore.log)"
tables="$(docker exec corner-ops-staging-postgres psql -U cornerops -d cornerops -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
employees="$(docker exec corner-ops-staging-postgres psql -U cornerops -d cornerops -Atc "SELECT count(*) FROM employees" 2>/dev/null || echo 0)"
(( tables > 50 && employees > 0 )) || { echo "Restore looks incomplete ($tables tables, $employees employees); see $STAGING/restore.log." >&2; exit 1; }
log "Restored $tables tables, $employees employees"
log "Restoring $(basename "$uploads")"
docker run --rm -i -v corner-ops-staging_uploads:/data alpine:3 sh -c 'tar -xzf - -C /data' < "$uploads"

log "Building and starting staging"
"${compose[@]}" build --quiet app
"${compose[@]}" up -d --wait app
curl -fsS "http://$address:3002/api/health" >/dev/null
"$SOURCE_REPO/deploy/staging/add-test-owner.sh" corner-ops-staging-postgres
log "Staging is up at http://$address:3002 ($sha, data from $(basename "$dump"))"
