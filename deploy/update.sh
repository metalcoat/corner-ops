#!/usr/bin/env bash
set -Eeuo pipefail

readonly BRANCH="agent/pos-ordering-foundation"
readonly REPOSITORY_URL="https://github.com/metalcoat/corner-ops.git"
readonly ROOT_DIR="/opt/corner-ops"
readonly RUNTIME_DIR="${ROOT_DIR}/runtime"
readonly DEPLOY_DIR="${ROOT_DIR}/deploy"
readonly STATE_DIR="${DEPLOY_DIR}/state"
readonly LOG_DIR="${DEPLOY_DIR}/logs"
readonly ENV_FILE="${ROOT_DIR}/.env"
readonly LOCK_FILE="${DEPLOY_DIR}/update.lock"
readonly COMPOSE_FILE="${RUNTIME_DIR}/docker-compose.local.yml"
readonly PROJECT_NAME="corner-ops"
export BUILDX_CONFIG="${DEPLOY_DIR}/buildx"

force=false
if [[ "${1:-}" == "--force" ]]; then
  force=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--force]\n' "$0" >&2
  exit 64
fi

install -d -m 0755 "$DEPLOY_DIR" "$STATE_DIR" "$LOG_DIR" "$BUILDX_CONFIG"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s Another Corner Ops update is already running; exiting.\n' "$(date -u +%FT%TZ)"
  exit 0
fi

readonly RUN_LOG="${LOG_DIR}/update-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$RUN_LOG") 2>&1

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"
}

read_state() {
  local name="$1"
  if [[ -f "${STATE_DIR}/${name}" ]]; then
    tr -d '\r\n' < "${STATE_DIR}/${name}"
  fi
}

write_state() {
  local name="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${STATE_DIR}/.${name}.XXXXXX")"
  printf '%s\n' "$value" > "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "${STATE_DIR}/${name}"
}

record_result() {
  local status="$1"
  write_state last_status "$status"
  write_state deployment_timestamp "$(date -u +%FT%TZ)"
}

restore_runtime_checkout() {
  local sha="$1"
  [[ -n "$sha" ]] || return 0
  git -C "$RUNTIME_DIR" checkout --force --detach "$sha"
  git -C "$RUNTIME_DIR" clean -ffdqx
}

record_candidate_failure() {
  local sha="$1"
  local reason="$2"
  local restore_sha="$3"
  log "Deployment failed for ${sha}: ${reason}"
  write_state failed_commit "$sha"
  write_state failure_reason "$reason"
  record_result failure
  restore_runtime_checkout "$restore_sha"
}

wait_for_health() {
  local attempt
  for attempt in {1..30}; do
    local app_health postgres_health
    app_health="$(docker inspect corner-ops-app --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    postgres_health="$(docker inspect corner-ops-postgres --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    if [[ "$app_health" == "healthy" && "$postgres_health" == "healthy" ]] \
      && curl -fsS --max-time 5 http://127.0.0.1:3000/api/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "Required local environment file is missing: ${ENV_FILE}"
  record_result configuration_error
  exit 1
fi

if [[ ! -d "${RUNTIME_DIR}/.git" ]]; then
  if [[ -e "$RUNTIME_DIR" ]]; then
    log "Runtime path exists but is not a Git checkout: ${RUNTIME_DIR}"
    record_result configuration_error
    exit 1
  fi
  log "Creating isolated runtime checkout."
  git clone --branch "$BRANCH" --single-branch "$REPOSITORY_URL" "$RUNTIME_DIR"
fi

runtime_origin="$(git -C "$RUNTIME_DIR" remote get-url origin)"
if [[ "$runtime_origin" != "$REPOSITORY_URL" ]]; then
  log "Refusing update because runtime origin is unexpected: ${runtime_origin}"
  record_result configuration_error
  exit 1
fi

log "Fetching origin/${BRANCH}."
git -C "$RUNTIME_DIR" fetch --prune origin "$BRANCH"
remote_sha="$(git -C "$RUNTIME_DIR" rev-parse FETCH_HEAD)"
deployed_sha="$(read_state current_successful_commit)"
failed_sha="$(read_state failed_commit)"
runtime_sha="$(git -C "$RUNTIME_DIR" rev-parse HEAD)"
write_state attempted_commit "$remote_sha"

if [[ "$force" == false && -n "$deployed_sha" && "$remote_sha" == "$deployed_sha" ]]; then
  log "Commit ${remote_sha} is already deployed; nothing to do."
  record_result no_change
  exit 0
fi

if [[ "$force" == false && -n "$failed_sha" && "$remote_sha" == "$failed_sha" ]]; then
  log "Commit ${remote_sha} previously failed; skipping until the remote SHA changes or --force is used."
  record_result skipped_failed_commit
  exit 0
fi

log "Preparing candidate ${remote_sha}."
git -C "$RUNTIME_DIR" checkout --force --detach "$remote_sha"
git -C "$RUNTIME_DIR" clean -ffdqx

validation_failed=false
(
  cd "$RUNTIME_DIR"
  npm ci
  npm run typecheck
  npm run build
  git restore --worktree -- tsconfig.tsbuildinfo
  git diff --check
  git diff --quiet
  git diff --cached --quiet
  [[ -z "$(git status --porcelain --untracked-files=all)" ]]
) || validation_failed=true

if [[ "$validation_failed" == true ]]; then
  record_candidate_failure "$remote_sha" "npm validation failed" "$runtime_sha"
  exit 1
fi

previous_image_id="$(docker inspect corner-ops-app --format '{{.Image}}' 2>/dev/null || true)"
if [[ -n "$previous_image_id" ]]; then
  docker tag "$previous_image_id" corner-ops-app:rollback
fi

image_build_failed=false
docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build app \
  || image_build_failed=true
if [[ "$image_build_failed" == true ]]; then
  record_candidate_failure "$remote_sha" "Docker image build failed" "$runtime_sha"
  exit 1
fi

log "Starting candidate ${remote_sha}; persistent volumes are unchanged."
docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build postgres
docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --no-build --force-recreate app

if ! wait_for_health; then
  log "Candidate health checks failed."
  if [[ -n "$previous_image_id" ]]; then
    log "Restoring the previous application image."
    docker tag corner-ops-app:rollback corner-ops-app:latest
    docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --no-build --force-recreate app
    if ! wait_for_health; then
      log "WARNING: previous application image did not return to healthy state."
    fi
  else
    log "WARNING: no previous application image was available for rollback."
  fi
  record_candidate_failure "$remote_sha" "post-deployment health checks failed" "$runtime_sha"
  exit 1
fi

if [[ -n "$deployed_sha" && "$deployed_sha" != "$remote_sha" ]]; then
  write_state previous_successful_commit "$deployed_sha"
fi
write_state current_successful_commit "$remote_sha"
write_state failed_commit ""
write_state failure_reason ""
record_result success
git -C "$RUNTIME_DIR" restore --worktree -- tsconfig.tsbuildinfo
log "Successfully deployed ${remote_sha}."
