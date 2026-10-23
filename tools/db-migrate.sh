#!/usr/bin/env bash
# Apply db/migrations to a Corner Ops PostgreSQL container, oldest first, once each.
#
#   tools/db-migrate.sh --container corner-ops-postgres            apply what hasn't run yet
#   tools/db-migrate.sh --container corner-ops-postgres --status   list applied / pending
#   tools/db-migrate.sh --container NAME --adopt                   first run on a database the
#       app built for itself (dev, production before the switchover): runs every file, skips
#       statements that fail only because the object or row is already there, then records all
#       files as applied. Refuses if the database already has migration records.
#
# Each file runs in one transaction and is recorded in schema_migrations with its git blob hash
# ("git-blob:<sha1>", the form production's records already use).
# A recorded file whose contents later changed is reported and stops the run: add a new file.
# The database user and name come from the container's POSTGRES_USER / POSTGRES_DB.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="${ROOT}/db/migrations"
container="" mode=apply
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) container="${2:-}"; shift 2 ;;
    --status) mode=status; shift ;;
    --adopt) mode=adopt; shift ;;
    *) echo "usage: $0 --container NAME [--status|--adopt]" >&2; exit 64 ;;
  esac
done
[[ -n "$container" ]] || { echo "usage: $0 --container NAME [--status|--adopt]" >&2; exit 64; }

db_user="$(docker exec "$container" sh -c 'printf %s "${POSTGRES_USER:-postgres}"')"
db_name="$(docker exec "$container" sh -c 'printf %s "${POSTGRES_DB:-$POSTGRES_USER}"')"
psql_in() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$container" psql -X -q -U "$db_user" -d "$db_name" "$@"; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

has_records_table() { [[ "$(psql_in -At -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" == t ]]; }
# On an empty database the baseline creates schema_migrations itself (0001d).
if [[ "$mode" == adopt ]]; then
  psql_in -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null
fi

declare -A recorded=()
if has_records_table; then
  while IFS='|' read -r name sum; do
    [[ -n "$name" ]] && recorded["$name"]="$sum"
  done < <(psql_in -At -c "SELECT migration_name, checksum FROM schema_migrations")
fi

mapfile -t files < <(find "$MIGRATIONS" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
checksum() { printf 'git-blob:%s' "$(git hash-object "${MIGRATIONS}/$1")"; }
# (No ON CONFLICT: the baseline's schema_migrations has no primary key until 0001e1.)
record() { psql_in -v ON_ERROR_STOP=1 --single-transaction -c "DELETE FROM schema_migrations WHERE migration_name = '$1'" -c "INSERT INTO schema_migrations(migration_name, checksum) VALUES ('$1', '$2')" >/dev/null; }

if [[ "$mode" == adopt ]]; then
  if [[ ${#recorded[@]} -gt 0 ]]; then
    log "Refusing to adopt: ${container} already has ${#recorded[@]} migration records. Run without --adopt."
    exit 1
  fi
  # Errors that only mean "already there": duplicate table/object/column/schema/function,
  # a second primary key, a duplicate seed row, an index or constraint name already in use.
  tolerated='42P07|42710|42701|42P06|42723|42P16|23505'
  # Two passes: a statement can depend on a column a later file adds (an older baseline index on a
  # column the app added itself), so whatever failed the first time runs again after everything else.
  retry=("${files[@]}") failed=false
  for pass in 1 2; do
    again=()
    for file in "${retry[@]}"; do
      output="$( { echo '\set VERBOSITY verbose'; cat "${MIGRATIONS}/${file}"; } | psql_in -v ON_ERROR_STOP=0 2>&1 >/dev/null || true)"
      other="$(grep -E '^(psql:.*)?ERROR:' <<<"$output" | grep -Ev "ERROR:  (${tolerated}):" || true)"
      skipped="$(grep -cE "ERROR:  (${tolerated}):" <<<"$output" || true)"
      if [[ -z "$other" ]]; then
        log "adopted ${file} (${skipped} statements already in place)"
      elif [[ "$pass" == 1 ]]; then
        again+=("$file")
        log "${file}: retrying after the other files ($(wc -l <<<"$other") statements failed)"
      else
        failed=true
        log "FAILED ${file}:"; printf '%s\n' "$other" | head -n 10
      fi
    done
    [[ ${#again[@]} -eq 0 ]] && break
    retry=("${again[@]}")
  done
  if [[ "$failed" == true ]]; then
    log "Adoption stopped with errors; nothing recorded. Fix the files above and run --adopt again."
    exit 1
  fi
  for file in "${files[@]}"; do record "$file" "$(checksum "$file")"; done
  log "Recorded ${#files[@]} migrations as applied on ${container}."
  exit 0
fi

pending=()
for file in "${files[@]}"; do
  sum="$(checksum "$file")"
  if [[ -n "${recorded[$file]:-}" ]]; then
    if [[ "${recorded[$file]}" != "$sum" ]]; then
      log "${file} changed after it was applied to ${container}. Put the change in a new migration file."
      exit 1
    fi
    [[ "$mode" == status ]] && echo "applied  ${file}"
  else
    pending+=("$file")
    [[ "$mode" == status ]] && echo "pending  ${file}"
  fi
done
[[ "$mode" == status ]] && exit 0

if [[ ${#recorded[@]} -eq 0 && ${#pending[@]} -gt 0 ]] \
  && [[ "$(psql_in -At -c "SELECT to_regclass('public.employees') IS NOT NULL")" == t ]]; then
  log "${container} has app tables but no migration records. Run once with --adopt."
  exit 1
fi

unrecorded=()
for file in "${pending[@]}"; do
  log "applying ${file}"
  psql_in -v ON_ERROR_STOP=1 --single-transaction < "${MIGRATIONS}/${file}" >/dev/null
  unrecorded+=("$file")
  if has_records_table; then
    for done_file in "${unrecorded[@]}"; do record "$done_file" "$(checksum "$done_file")"; done
    unrecorded=()
  fi
done
log "${container}: ${#pending[@]} migration(s) applied, $(( ${#files[@]} - ${#pending[@]} )) already in place."
