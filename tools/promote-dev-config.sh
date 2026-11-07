#!/usr/bin/env bash
# Copies the store setup built on dev (menu, modifiers, prices, hours, delivery,
# taxes, printers and stations, loyalty, promotions, tip policy, AI phone
# settings) into another Corner Ops database, without dev's test orders,
# payments, sessions or logs. Used to rehearse the switch on staging and, with
# the owner's go-ahead, to set up production once.
#
#   tools/promote-dev-config.sh --target corner-ops-staging-postgres [--with-customers]
#
# --with-customers also copies the customer list (names, phones, emails,
# addresses imported from Rezku's CRM) but not their orders or loyalty history.
#
# The target must not have a menu yet (it refuses otherwise); everything is
# copied in one transaction, so a failure leaves the target unchanged.
# Menu photos live in the uploads volume and are not copied (there are none yet).
set -Eeuo pipefail

SOURCE="corner-ops-postgres"
target="" customers=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --with-customers) customers=true; shift ;;
    *) echo "usage: $0 --target CONTAINER [--with-customers]" >&2; exit 64 ;;
  esac
done
[[ -n "$target" && "$target" != "$SOURCE" ]] || { echo "usage: $0 --target CONTAINER [--with-customers]" >&2; exit 64; }

CONFIG_TABLES=(
  ordering_business_settings ordering_business_ordering_settings ordering_business_tax_settings ordering_tax_rate_history
  ordering_fulfillment_timing_settings ordering_operating_windows ordering_special_hours
  ordering_delivery_policies ordering_delivery_fee_bands
  ordering_menu_import_runs ordering_menu_categories ordering_category_overrides ordering_category_channel_overrides
  ordering_menu_items ordering_item_overrides ordering_item_channel_overrides ordering_menu_item_variants ordering_item_variant_print_overrides
  ordering_modifier_groups ordering_modifier_options ordering_menu_item_modifier_groups ordering_menu_item_modifier_defaults
  ordering_modifier_presentation_overrides ordering_menu_variant_modifier_prices ordering_menu_availability_rules
  ordering_menu_item_aliases ordering_menu_variant_aliases ordering_menu_local_fields ordering_menu_source_map
  ordering_loyalty_programs ordering_promotions ordering_tip_policies
  ordering_hardware_locations ordering_hardware_devices ordering_printer_routes ordering_payment_stations
  ordering_pos_terminals ordering_store_screens ordering_external_print_settings
  ordering_ai_phone_settings ordering_inventory_settings ordering_inventory_suppliers
  restaurant_concepts restaurant_locations restaurant_floor_plans restaurant_tables
)
CUSTOMER_TABLES=(ordering_crm_import_batches ordering_customers ordering_customer_phones ordering_customer_emails ordering_customer_addresses)

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
psql_in() { docker exec -i "$1" psql -X -q -v ON_ERROR_STOP=1 -U cornerops -d cornerops "${@:2}"; }

existing="$(psql_in "$target" -At -c "SELECT count(*) FROM ordering_menu_items")"
if [[ "$existing" != "0" ]]; then
  echo "$target already has $existing menu items; refusing to overwrite its menu." >&2
  exit 1
fi

tables=("${CONFIG_TABLES[@]}")
$customers && tables+=("${CUSTOMER_TABLES[@]}")
args=()
for table in "${tables[@]}"; do args+=(-t "public.$table"); done

# Seeded single rows (settings) may already exist in the target: clear them first.
clear_sql="SET session_replication_role = replica;"
for table in "${tables[@]}"; do clear_sql+=" DELETE FROM public.$table;"; done

log "Copying ${#tables[@]} tables from $SOURCE to $target"
dump="$(mktemp)"
trap 'rm -f "$dump"' EXIT
docker exec "$SOURCE" pg_dump -U cornerops -d cornerops --data-only --column-inserts --rows-per-insert=500 "${args[@]}" > "$dump"
# One transaction; replica mode skips FK and trigger checks while rows load in any order.
{
  echo "BEGIN;"
  echo "$clear_sql"
  grep -v -E '^(SET|SELECT pg_catalog\.set_config)' "$dump"
  echo "SET session_replication_role = origin;"
  echo "COMMIT;"
} | psql_in "$target" >/dev/null

for table in ordering_menu_items ordering_modifier_options ordering_operating_windows ordering_hardware_devices ordering_customers; do
  printf '  %-30s source %-6s target %s\n' "$table" \
    "$(psql_in "$SOURCE" -At -c "SELECT count(*) FROM $table")" "$(psql_in "$target" -At -c "SELECT count(*) FROM $table")"
done
log "Done. Restart the target app so cached settings reload."
