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
  corner-ops-supplier-prices.service corner-ops-supplier-prices.timer)
readonly TIMERS=(corner-ops-backup.timer corner-ops-cron-maintenance.timer
  corner-ops-cron-schedule-delivery.timer corner-ops-cron-scheduler.timer corner-ops-supplier-prices.timer)

if [[ "$(id -u)" != "0" ]]; then
  printf 'Run this with sudo; it installs systemd units.\n' >&2
  exit 1
fi
if ! grep -qE '^CRON_SECRET=.+' /opt/corner-ops/.env 2>/dev/null; then
  printf 'Add CRON_SECRET to /opt/corner-ops/.env first, e.g.:\n  echo "CRON_SECRET=$(openssl rand -hex 32)" >> /opt/corner-ops/.env\nthen run /opt/corner-ops/deploy/update.sh --force as chris so the app picks it up.\n' >&2
  exit 1
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
