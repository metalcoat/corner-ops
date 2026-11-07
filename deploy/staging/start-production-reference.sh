#!/usr/bin/env bash
# Runs the image production is running now, on its own fresh copy of last night's
# backup and with staging's safe settings, at <deli address>:3003. Compare it with
# staging using compare-with-production.py. Production itself is not touched.
set -Eeuo pipefail
readonly STAGING=/opt/corner-ops/staging BACKUPS=/opt/corner-ops/production/backups
address="${STAGING_ADDRESS:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
[[ "$address" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] || { echo "Not a private address ($address)." >&2; exit 1; }
image="$(docker inspect corner-ops-prod-app --format '{{.Image}}')"
dump="$(ls -1 "$BACKUPS"/cornerops-2*.dump | sort | tail -n 1)"; uploads="$(ls -1 "$BACKUPS"/uploads-2*.tar.gz | sort | tail -n 1)"
password="$(grep '^POSTGRES_PASSWORD=' "$STAGING/.env" | cut -d= -f2-)"
docker rm -f corner-ops-prodref-app corner-ops-prodref-postgres >/dev/null 2>&1 || true
docker volume rm corner-ops-prodref_pg corner-ops-prodref_uploads >/dev/null 2>&1 || true
docker network create corner-ops-prodref >/dev/null 2>&1 || true
docker run -d --name corner-ops-prodref-postgres --network corner-ops-prodref -e POSTGRES_DB=cornerops -e POSTGRES_USER=cornerops \
  -e POSTGRES_PASSWORD="$password" -v corner-ops-prodref_pg:/var/lib/postgresql/data postgres:17-bookworm >/dev/null
until docker exec corner-ops-prodref-postgres pg_isready -U cornerops -d cornerops >/dev/null 2>&1; do sleep 1; done; sleep 2
docker exec -i corner-ops-prodref-postgres pg_restore -U cornerops -d cornerops --no-owner --no-acl < "$dump" 2>/dev/null || true
docker run --rm -i -v corner-ops-prodref_uploads:/data alpine:3 sh -c 'tar -xzf - -C /data' < "$uploads"
docker run -d --name corner-ops-prodref-app --network corner-ops-prodref --env-file "$STAGING/.env" \
  -e NODE_ENV=production -e APP_ENV=staging -e DATABASE_DRIVER=postgres \
  -e DATABASE_URL="postgresql://cornerops:$password@corner-ops-prodref-postgres:5432/cornerops" \
  -e STORAGE_DRIVER=local -e LOCAL_STORAGE_PATH=/data/uploads -e HEALTHCHECK_DATABASE=true \
  -e APP_URL="http://$address:3003" -e EMPLOYEE_APP_URL="http://$address:3003" \
  -v corner-ops-prodref_uploads:/data/uploads -p "$address:3003:3000" "$image" >/dev/null
for _ in $(seq 60); do curl -fsS "http://$address:3003/api/health" >/dev/null 2>&1 && break; sleep 2; done
"$(dirname "$0")/add-test-owner.sh" corner-ops-prodref-postgres
echo "Production reference ($(basename "$dump")) at http://$address:3003. Remove with: docker rm -f corner-ops-prodref-app corner-ops-prodref-postgres"
