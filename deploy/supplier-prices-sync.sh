#!/usr/bin/env bash
# Sends supplier price files to the app's Supplier costs page.
#
# Drop a supplier's order-guide export (CSV or tab-separated) into a folder named
# after the supplier, exactly as it's named in Supplier costs:
#   /opt/corner-ops/supplier-prices/Sysco/order-guide.csv
#   /opt/corner-ops/supplier-prices/US Foods/export.csv
# This script (run daily by corner-ops-supplier-prices.timer, or by hand) posts each
# new file, then moves it to <supplier>/done/ (or <supplier>/failed/ with the error).
# With --website it instead signs in to Sysco, US Foods and PFG and pulls prices
# from their sites (corner-ops-supplier-website.timer runs that twice a day).
# With --signin webstaurant (or accountantsoffice) it opens that site for a person to sign in to by
# hand (a robot check, or a texted code): it prints a link to open from the deli network.
set -Eeuo pipefail

readonly ROOT="${CORNER_OPS_ROOT:-/opt/corner-ops}"
readonly DROP="${SUPPLIER_PRICES_DIR:-$ROOT/supplier-prices}"
readonly ENV_FILE="$ROOT/.env"

secret="$(grep -E '^[[:space:]]*(export[[:space:]]+)?CRON_SECRET[[:space:]]*=' "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- \
  | sed -E -e 's/\r$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'$/\1/" || true)"
if [[ -z "$secret" ]]; then
  printf '%s CRON_SECRET is not set in %s.\n' "$(date -u +%FT%TZ)" "$ENV_FILE" >&2
  exit 1
fi
mkdir -p "$DROP" "$DROP/_website"

# --website: sign in to the suppliers' sites and pull today's prices (see
# deploy/supplier-scraper). Optional second argument limits it to one supplier:
#   supplier-prices-sync.sh --website sysco
website() {
  # One website run at a time: they share each supplier's browser profile.
  exec 8>"$DROP/_website/.lock"
  # A website search waits for a run that's already going (up to 20 minutes); a price run just skips.
  local wait=(-n)
  (( ${#search_env[@]} )) && wait=(-w 1200)
  if ! flock "${wait[@]}" 8; then
    printf '%s A website price run is already going; skipping.\n' "$(date -u +%FT%TZ)"
    return 0
  fi
  local compose=(docker compose --project-name corner-ops --env-file "$ENV_FILE" -f "$ROOT/runtime/docker-compose.local.yml" --profile tools)
  "${compose[@]}" build --quiet supplier-prices
  "${compose[@]}" run --rm --no-deps "${search_env[@]}" supplier-prices "$@"
}
search_env=()
# --signin <site>: the price job's browser, shown as a web page on this box's
# deli-network address only (never 0.0.0.0, nothing through Cloudflare), with a
# one-time password. It closes once the person is signed in, or after 15 minutes.
signin() {
  exec 8>"$DROP/_website/.lock"
  if ! flock -n 8; then
    printf '%s A website price run is going; try again in a few minutes.\n' "$(date -u +%FT%TZ)" >&2
    return 1
  fi
  local address="${SIGNIN_ADDRESS:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
  if [[ ! "$address" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
    printf 'Not a private network address (%s); set SIGNIN_ADDRESS to this box'"'"'s deli-network address.\n' "$address" >&2
    return 1
  fi
  local password
  password="$(tr -dc 'a-km-z2-9' < /dev/urandom | head -c 8 || true)"
  local compose=(docker compose --project-name corner-ops --env-file "$ENV_FILE" -f "$ROOT/runtime/docker-compose.local.yml" --profile tools)
  "${compose[@]}" build --quiet supplier-prices
  printf '\nOn a phone or computer on the deli network, open:\n  http://%s:6080/vnc.html?autoconnect=1&resize=scale&password=%s\nSign in there; this closes by itself once you are signed in.\n\n' "$address" "$password"
  "${compose[@]}" run --rm --no-deps -p "$address:6080:6080" -e VNC_PASSWORD="$password" \
    --entrypoint /scraper/signin.sh supplier-prices "$@"
}
if [[ "${1:-}" == "--signin" ]]; then
  shift
  signin "$@"
  exit $?
fi
if [[ "${1:-}" == "--website" ]]; then
  shift
  website "$@"
  exit $?
fi

shopt -s nullglob
status=0
for dir in "$DROP"/*/; do
  supplier="$(basename "$dir")"
  # _website holds the website job's own debug files, not a supplier's prices.
  [[ "$supplier" == _* ]] && continue
  for file in "$dir"*.csv "$dir"*.txt "$dir"*.tsv; do
    stamp="$(date +%Y%m%d-%H%M%S)"
    body="$(python3 -c 'import json,sys; print(json.dumps({"supplier": sys.argv[1], "csv": open(sys.argv[2], encoding="utf-8-sig", errors="replace").read()}))' "$supplier" "$file")"
    if result="$(curl -fsS --max-time 300 -H 'content-type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$secret") \
        --data-binary @<(printf '%s' "$body") http://127.0.0.1:3000/api/cron/supplier-prices 2>&1)"; then
      mkdir -p "${dir}done"
      mv "$file" "${dir}done/${stamp}-$(basename "$file")"
      printf '%s %s: %s\n' "$(date -u +%FT%TZ)" "$supplier" "$result"
    else
      mkdir -p "${dir}failed"
      mv "$file" "${dir}failed/${stamp}-$(basename "$file")"
      printf '%s\n' "$result" > "${dir}failed/${stamp}-$(basename "$file").error"
      printf '%s %s failed: %s\n' "$(date -u +%FT%TZ)" "$supplier" "$result" >&2
      status=1
    fi
  done
done
# "Sync prices now" pressed on Supplier costs: run the website job for those suppliers.
requested="$(curl -fsS --max-time 30 -H @<(printf 'Authorization: Bearer %s\n' "$secret") 'http://127.0.0.1:3000/api/cron/supplier-prices?requested=1' 2>/dev/null \
  | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin).get("suppliers", [])))' 2>/dev/null || true)"
while IFS= read -r supplier; do
  [[ -n "$supplier" ]] || continue
  printf '%s Sync now: %s\n' "$(date -u +%FT%TZ)" "$supplier"
  website "$supplier" || status=1
done <<< "$requested"

# "Search the suppliers' websites" pressed on Supplier costs: look each term up on every supplier's site.
searches="$(curl -fsS --max-time 30 -H @<(printf 'Authorization: Bearer %s\n' "$secret") 'http://127.0.0.1:3000/api/cron/supplier-prices?searches=1' 2>/dev/null \
  | python3 -c 'import json,sys; [print(s["id"] + "\t" + s["query"].replace("\t", " ").replace("\n", " ")) for s in json.load(sys.stdin).get("searches", [])]' 2>/dev/null || true)"
while IFS=$'\t' read -r search_id query; do
  [[ -n "$search_id" && -n "$query" ]] || continue
  printf '%s Website search: %s\n' "$(date -u +%FT%TZ)" "$query"
  search_env=(-e "SEARCH_QUERY=$query" -e "SEARCH_ID=$search_id")
  website || status=1
  search_env=()
done <<< "$searches"

exit "$status"
