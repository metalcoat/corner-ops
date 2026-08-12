#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) {
  throw new Error("Pricing validation requires the private local Corner Ops PostgreSQL container.");
}
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const sql = getSql();

  type ItemRow = { id: string; name: string };
  type VariantRow = { id: string; name: string; base_price_cents: number };
  type OptionRow = { group_id: string; group_name: string; min_selections: number; option_id: string; option_name: string; price_delta_cents: number };

  async function configuredItem(itemName: string, variantName: string, requestedOptions: string[]) {
    const itemRows = await sql`SELECT id, name FROM ordering_menu_items WHERE business = 'Corner Deli' AND name = ${itemName} AND active = TRUE LIMIT 1` as ItemRow[];
    const menuItem = itemRows[0];
    if (!menuItem) throw new Error(`Missing menu item ${itemName}.`);
    const variantRows = await sql`SELECT id, name, base_price_cents FROM ordering_menu_item_variants WHERE item_id = ${menuItem.id} AND name = ${variantName} AND active = TRUE LIMIT 1` as VariantRow[];
    const variant = variantRows[0];
    if (!variant) throw new Error(`Missing ${itemName} variant ${variantName}.`);
    const options = await sql`
      SELECT grp.id AS group_id, grp.name AS group_name, grp.min_selections, opt.id AS option_id,
             opt.name AS option_name, COALESCE(def.price_delta_override_cents, opt.price_delta_cents) AS price_delta_cents
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active = TRUE
      JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.active = TRUE AND opt.available = TRUE
      LEFT JOIN ordering_menu_item_modifier_defaults def ON def.item_id = link.item_id AND def.option_id = opt.id AND def.active = TRUE
      WHERE link.item_id = ${menuItem.id}
      ORDER BY link.sort_order, opt.sort_order, opt.name
    ` as OptionRow[];
    const selections: Record<string, string[]> = {};
    for (const row of options) {
      if (!selections[row.group_id]) selections[row.group_id] = [];
      if (requestedOptions.includes(row.option_name) && !selections[row.group_id].includes(row.option_id)) selections[row.group_id].push(row.option_id);
    }
    for (const row of options) {
      while (selections[row.group_id].length < Number(row.min_selections)) {
        const candidate = options.find((option) => option.group_id === row.group_id && !selections[row.group_id].includes(option.option_id));
        if (!candidate) throw new Error(`Cannot satisfy ${itemName} group ${row.group_name}.`);
        selections[row.group_id].push(candidate.option_id);
      }
    }
    return { menuItem, variant, selections };
  }

  const cases: Array<[string, string, string, string[]]> = [
    ["small-pizza", "Pizza", "Small 12\"", []],
    ["regular-pizza-topping", "Pizza", "Regular 14\"", ["Pepperoni"]],
    ["jumbo-thin-multiple", "Pizza", "Jumbo Thin 16\"", ["Pepperoni", "Mushrooms"]],
    ["sheet-pizza", "Pizza", "Sheet Pizza", []],
    ["turkey-full", "Turkey", "Full Sub", []],
    ["turkey-half", "Turkey", "1/2 Sub", []],
    ["turkey-wrap", "Turkey", "Wraps", []],
    ["big-boss-wrap", "Turkey Big Boss", "Wraps", []],
    ["steak-wrap", "Steak", "Wraps", []],
    ["pizza-sub", "Pizza Sub", "Full Sub", []],
    ["wings", "Wings", "10 Wings", ["Mild", "Flats/Wings"]],
  ];
  const results: unknown[] = [];
  for (const [label, itemName, variantName, requestedOptions] of cases) {
    const configured = await configuredItem(itemName, variantName, requestedOptions);
    try {
      await withTransaction(async () => {
        const order = await createDraftOrderWithVariants({
          business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "rezku-pricing-smoke-test",
          items: [{ itemId: configured.menuItem.id, variantId: configured.variant.id, modifierSelections: configured.selections }],
        });
        const rows = await getSql()`
          SELECT variant_name_snapshot, unit_price_cents, modifier_total_cents, line_total_cents,
                 (SELECT COUNT(*)::INTEGER FROM ordering_order_item_modifiers m WHERE m.order_item_id = item.id AND m.selection_state IN ('selected','extra')) AS selected_modifiers
          FROM ordering_order_items item WHERE order_id = ${order.id}
        `;
        const row = rows[0];
        if (row.variant_name_snapshot !== variantName || Number(row.unit_price_cents) !== Number(configured.variant.base_price_cents)) throw new Error(`${label}: variant snapshot mismatch.`);
        if (Number(row.line_total_cents) !== Number(row.unit_price_cents) + Number(row.modifier_total_cents)) throw new Error(`${label}: nondeterministic line total.`);
        results.push({ label, variant: variantName, basePriceCents: Number(row.unit_price_cents), modifierCents: Number(row.modifier_total_cents), totalCents: Number(row.line_total_cents), selectedModifiers: Number(row.selected_modifiers) });
        throw new Error(`rollback:${label}`);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== `rollback:${label}`) throw error;
    }
  }

  const pizzaSub = await configuredItem("Pizza Sub", "Full Sub", []);
  const turkeyWrap = await configuredItem("Turkey", "Wraps", []);
  const { resolveItemVariantPricing } = await import("../src/lib/ordering-variant-pricing");
  let unsupportedVariantRejected = false;
  try { await resolveItemVariantPricing({ business: "Corner Deli", itemId: pizzaSub.menuItem.id, variantId: turkeyWrap.variant.id }); }
  catch { unsupportedVariantRejected = true; }
  if (!unsupportedVariantRejected) throw new Error("Pizza Sub incorrectly accepted a Wrap variant.");

  const leftover = await sql`SELECT COUNT(*)::INTEGER AS count FROM ordering_orders WHERE created_by = 'rezku-pricing-smoke-test'`;
  if (Number(leftover[0].count) !== 0) throw new Error("Rollback-only pricing tests left draft orders behind.");
  console.log(JSON.stringify({ results, unsupportedVariantRejected, draftRollbacksVerified: true }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
