#!/usr/bin/env bash
# One-time setup, run by a person with sudo (the jobs themselves run as chris):
#   sudo /opt/corner-ops/runtime/deploy/install-timers.sh
# (The scripts run from the deployed checkout in /opt/corner-ops/runtime, which
# deploy/update.sh keeps current; /opt/corner-ops/deploy only holds update.sh,
# its state and logs.)
# Installs and starts the nightly backup and the app's scheduled jobs.
set -Eeuo pipefail

readonly SOURCE_DIR="$(cd "$(dirname "$0")/systemd" && pwd)"
readonly UNITS=(corner-ops-backup.service corner-ops-backup.timer corner-ops-cron@.service
  corner-ops-cron-maintenance.timer corner-ops-cron-schedule-delivery.timer corner-ops-cron-scheduler.timer
  corner-ops-supplier-prices.service corner-ops-supplier-prices.timer
  corner-ops-supplier-website.service corner-ops-supplier-website.timer)
readonly TIMERS=(corner-ops-backup.timer corner-ops-cron-maintenance.timer
  corner-ops-cron-schedule-delivery.timer corner-ops-cron-scheduler.timer corner-ops-supplier-prices.timer
  corner-ops-supplier-website.timer)

if [[ "$(id -u)" != "0" ]]; then
  printf 'Run this with sudo; it installs systemd units.\n' >&2
  exit 1
fi
readonly ENV_FILE=/opt/corner-ops/.env
if [[ ! -f "$ENV_FILE" ]]; then
  printf '%s not found. The app'"'"'s settings file has to exist first.\n' "$ENV_FILE" >&2
  exit 1
fi
# The scheduled jobs prove who they are to the app with CRON_SECRET. Accept it
# written as CRON_SECRET=..., "export CRON_SECRET=...", with spaces or quotes;
# store it in the plain form Docker Compose and the job scripts read.
readonly SECRET_LINE='^[[:space:]]*(export[[:space:]]+)?CRON_SECRET[[:space:]]*='
secret="$(grep -E "$SECRET_LINE" "$ENV_FILE" | tail -n 1 | sed -E \
  -e "s/${SECRET_LINE}[[:space:]]*//" -e 's/\r$//' -e 's/[[:space:]]+$//' \
  -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'$/\1/" || true)"
restart_needed=false
if [[ -z "$secret" ]]; then
  secret="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  restart_needed=true
  printf 'CRON_SECRET was not set in %s; generated one.\n' "$ENV_FILE"
elif ! grep -qxE "CRON_SECRET=${secret}" "$ENV_FILE"; then
  restart_needed=true
  printf 'Rewrote CRON_SECRET in %s in the plain CRON_SECRET=... form.\n' "$ENV_FILE"
fi
if [[ "$restart_needed" == true ]]; then
  cp -p "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d%H%M%S)"
  # Keep the file's owner and permissions; replace any old CRON_SECRET lines.
  tmp="$(mktemp)"
  grep -vE "$SECRET_LINE" "$ENV_FILE" > "$tmp" || true
  printf 'CRON_SECRET=%s\n' "$secret" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
fi
for script in backup-db.sh run-cron.sh supplier-prices-sync.sh; do
  if [[ ! -x "/opt/corner-ops/runtime/deploy/${script}" ]]; then
    printf 'Missing /opt/corner-ops/runtime/deploy/%s. Run /opt/corner-ops/deploy/update.sh --force as chris first.\n' "$script" >&2
    exit 1
  fi
done
for unit in "${UNITS[@]}"; do
  install -m 0644 "${SOURCE_DIR}/${unit}" "/etc/systemd/system/${unit}"
done
systemctl daemon-reload
systemctl enable --now "${TIMERS[@]}"
systemctl list-timers 'corner-ops-*' --no-pager
if [[ "$restart_needed" == true ]]; then
  printf '\nNow run this as chris so the app picks up CRON_SECRET (the jobs are refused until it does):\n  /opt/corner-ops/deploy/update.sh --force\n'
fi
