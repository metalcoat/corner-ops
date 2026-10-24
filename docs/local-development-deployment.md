# Local development deployment

This architecture is for the Corner Ops Ubuntu development VM only. It is not a production deployment, does not deploy to Vercel, and must never use production credentials or a production Neon database.

## Paths and branch

- `/opt/corner-ops/app` is the Codex development workspace. The updater never checks out, cleans, or resets this directory.
- `/opt/corner-ops/runtime` is the clean deployment checkout. It is detached at a commit fetched from `origin/agent/pos-ordering-foundation`.
- `/opt/corner-ops/.env` contains local-only configuration and secrets. It is outside the repository and must never be committed.
- `/opt/corner-ops/deploy/update.sh` is the installed updater.
- `/opt/corner-ops/deploy/state` records attempted, failed, current successful, and previous successful commits plus timestamps and results.
- `/opt/corner-ops/deploy/logs` contains one log file per updater run. The same output is available in the systemd journal.

Only commits present on `origin/agent/pos-ordering-foundation` are eligible for automatic deployment. The updater uses a non-blocking `flock`, so overlapping deployments exit without changing anything. A failed SHA is recorded and skipped on later timer runs until the remote SHA changes or an operator requests a forced retry.

## Containers and persistence

The tracked `docker-compose.local.yml` runs the application and PostgreSQL on the `corner-ops` Docker network. The application is published on port 3000 for development LAN access. PostgreSQL port 5432 is not published to the host.

The `corner-ops_cornerops_postgres_data` named volume stores PostgreSQL data, and `corner-ops_cornerops_uploads` stores local uploads. Both volumes live outside the disposable runtime checkout. Ordinary deployments build and replace only the application container and do not delete, reset, or seed either volume.

The local runtime selects the PostgreSQL database driver and local storage driver through the Compose environment. The source retains the Neon and Vercel Blob drivers for a possible future cloud deployment; the local updater does not access or deploy those services.

## Updater operation

The `corner-ops-update.timer` checks approximately every 60 seconds and survives reboot. A candidate commit must pass `npm ci`, type checking, the production application build, the Docker image build, container health checks, and an HTTP 200 response from `/api/health` before it is marked successful.

The running application continues using its existing image while candidate validation and image building happen. Immediately before the candidate starts, the updater tags the running image as `corner-ops-app:rollback`. If post-start health checks fail, it restores that image and recreates only the application container. PostgreSQL and upload volumes are left in place. The updater then restores the runtime checkout to its prior commit and records the failed SHA.

Useful commands:

```bash
systemctl status corner-ops-update.timer
systemctl list-timers corner-ops-update.timer
journalctl -u corner-ops-update.service
sudo systemctl start corner-ops-update.service
sudo /opt/corner-ops/deploy/update.sh --force
docker compose --project-name corner-ops --env-file /opt/corner-ops/.env -f /opt/corner-ops/runtime/docker-compose.local.yml ps
```

To stop or start the local application without removing data:

```bash
docker compose --project-name corner-ops --env-file /opt/corner-ops/.env -f /opt/corner-ops/runtime/docker-compose.local.yml stop app
docker compose --project-name corner-ops --env-file /opt/corner-ops/.env -f /opt/corner-ops/runtime/docker-compose.local.yml up -d --no-build app
```

For a manual rollback, identify `previous_successful_commit` under `/opt/corner-ops/deploy/state`, confirm that commit is still appropriate, and deploy it deliberately. Automatic rollback is limited to restoring the application image after a failed health check; database schema downgrades are intentionally not automated because the application performs additive initialization and destructive database operations are prohibited.
