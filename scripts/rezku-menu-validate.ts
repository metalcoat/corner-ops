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
  type OptionRow = { group_id: string; group_name: string; min_selections: number; max_selections: number; allow_option_quantity: boolean; option_id: string; option_name: string; price_delta_cents: number };

  async function configuredItem(itemName: string, variantName: string, requestedOptions: string[]) {
    const itemRows = await sql`SELECT id, name FROM ordering_menu_items WHERE business = 'Corner Deli' AND name = ${itemName} AND active = TRUE LIMIT 1` as ItemRow[];
    const menuItem = itemRows[0];
    if (!menuItem) throw new Error(`Missing menu item ${itemName}.`);
    const variantRows = await sql`SELECT id, name, base_price_cents FROM ordering_menu_item_variants WHERE item_id = ${menuItem.id} AND name = ${variantName} AND active = TRUE LIMIT 1` as VariantRow[];
    const variant = variantRows[0];
    if (!variant) throw new Error(`Missing ${itemName} variant ${variantName}.`);
    const options = await sql`
      SELECT grp.id AS group_id, grp.name AS group_name, grp.min_selections, grp.max_selections,
             grp.allow_option_quantity, opt.id AS option_id,
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
    const pizzaToppings = options.filter((option) => option.group_name === "Pizza Toppings" && requestedOptions.includes(option.option_name)).map((option) => ({ modifierOptionId: option.option_id, portion: "whole" as const, amount: "regular" as const }));
    for (const option of options.filter((candidate) => candidate.group_name === "Pizza Toppings")) selections[option.group_id] = [];
    return { menuItem, variant, selections, options, pizzaToppings };
  }

  const cases: Array<[string, string, string, string[]]> = [
    ["small-pizza", "Pizza", "Small 12\"", []],
    ["regular-pizza-topping", "Pizza", "Regular 14\"", ["Pepperoni"]],
    ["jumbo-thin-multiple", "Pizza", "Jumbo Thin 16\"", ["Pepperoni", "Mushrooms"]],
    ["jumbo-thick", "Pizza", "Jumbo Thick 16\"", []],
    ["sheet-pizza", "Pizza", "Sheet Pizza", []],
    ["breakfast-small", "Breakfast Pizza", "Small 12\"", []],
    ["breakfast-regular", "Breakfast Pizza", "Regular 14\"", []],
    ["breakfast-jumbo-thick", "Breakfast Pizza", "Jumbo Thick 16\"", []],
    ["breakfast-jumbo-thin", "Breakfast Pizza", "Jumbo Thin 16\"", []],
    ["turkey-full", "Turkey", "Full Sub", []],
    ["turkey-half", "Turkey", "1/2 Sub", []],
    ["turkey-wrap", "Turkey", "Wraps", []],
    ["big-boss-full", "Turkey Big Boss", "Full Sub", []],
    ["big-boss-half", "Turkey Big Boss", "1/2 Sub", []],
    ["big-boss-wrap", "Turkey Big Boss", "Wraps", []],
    ["steak-full", "Steak", "Full Sub", []],
    ["steak-half", "Steak", "1/2 Sub", []],
    ["steak-wrap", "Steak", "Wraps", []],
    ["chicken-bacon-ranch-full", "Chicken Bacon Ranch", "Full Sub", []],
    ["chicken-bacon-ranch-half", "Chicken Bacon Ranch", "1/2 Sub", []],
    ["chicken-bacon-ranch-wrap", "Chicken Bacon Ranch", "Wraps", []],
    ["pizza-sub-full", "Pizza Sub", "Full Sub", []],
    ["pizza-sub-half", "Pizza Sub", "1/2 Sub", []],
    ["garlic-meatball-pepperoni-full", "Garlic Meatball Pepperoni Sub", "Full Sub", []],
    ["pepperoni-chicken-parmesan-full", "Pepperoni Chicken Parmesan Sub", "Full Sub", []],
    ["wings", "Wings", "10 Wings", ["Mild", "Flats/Wings"]],
  ];
  const results: unknown[] = [];
  for (const [label, itemName, variantName, requestedOptions] of cases) {
    const configured = await configuredItem(itemName, variantName, requestedOptions);
    try {
      await withTransaction(async () => {
        const order = await createDraftOrderWithVariants({
          business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "rezku-pricing-smoke-test",
          items: [{ itemId: configured.menuItem.id, variantId: configured.variant.id, modifierSelections: configured.selections, pizzaToppings: configured.pizzaToppings }],
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

  const restrictedVariantRows = await sql`
    SELECT item.name, ARRAY_AGG(variant.name ORDER BY variant.sort_order) AS variants
    FROM ordering_menu_items item
    JOIN ordering_menu_item_variants variant ON variant.item_id = item.id AND variant.active = TRUE
    WHERE item.business = 'Corner Deli'
      AND item.name IN ('Pizza Sub', 'Garlic Meatball Pepperoni Sub', 'Pepperoni Chicken Parmesan Sub')
    GROUP BY item.name
  ` as Array<{ name: string; variants: string[] }>;
  const restrictedVariants = Object.fromEntries(restrictedVariantRows.map((row) => [row.name, row.variants]));
  if (JSON.stringify(restrictedVariants["Pizza Sub"]) !== JSON.stringify(["Full Sub", "1/2 Sub"])) {
    throw new Error("Pizza Sub variant restriction changed.");
  }
  for (const name of ["Garlic Meatball Pepperoni Sub", "Pepperoni Chicken Parmesan Sub"]) {
    if (JSON.stringify(restrictedVariants[name]) !== JSON.stringify(["Full Sub"])) throw new Error(`${name} is not Full-only.`);
  }

  const chicken = await configuredItem("Chicken Bacon Ranch", "Full Sub", []);
  let missingRequiredModifierRejected = false;
  try {
    await createDraftOrderWithVariants({
      business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "rezku-pricing-smoke-test",
      items: [{ itemId: chicken.menuItem.id, variantId: chicken.variant.id, modifierSelections: {} }],
    });
  } catch (error) {
    missingRequiredModifierRejected = error instanceof Error && error.message.startsWith("Required modifier choices");
  }
  if (!missingRequiredModifierRejected) throw new Error("Missing required modifiers were not rejected.");

  const limitedGroup = chicken.options.find((option) => Number(option.max_selections) === 1);
  const extraInLimitedGroup = limitedGroup && chicken.options.find((option) => option.group_id === limitedGroup.group_id && option.option_id !== limitedGroup.option_id);
  if (!limitedGroup || !extraInLimitedGroup) throw new Error("Could not locate a max-one modifier group for validation.");
  let tooManyModifiersRejected = false;
  try {
    await createDraftOrderWithVariants({
      business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "rezku-pricing-smoke-test",
      items: [{
        itemId: chicken.menuItem.id,
        variantId: chicken.variant.id,
        modifierSelections: { ...chicken.selections, [limitedGroup.group_id]: [limitedGroup.option_id, extraInLimitedGroup.option_id] },
      }],
    });
  } catch (error) {
    tooManyModifiersRejected = error instanceof Error && error.message.startsWith("Required modifier choices");
  }
  if (!tooManyModifiersRejected) throw new Error("Too many modifier choices were not rejected.");

  const regularPizza = await configuredItem("Pizza", "Regular 14\"", ["Pepperoni"]);
  const pepperoni = regularPizza.options.find((option) => option.option_name === "Pepperoni" && option.allow_option_quantity);
  if (!pepperoni) throw new Error("Pizza Toppings did not retain Rezku option-quantity support.");
  let modifierQuantityVerified = false;
  try {
    await withTransaction(async () => {
      const order = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "rezku-pricing-smoke-test",
        items: [{
          itemId: regularPizza.menuItem.id,
          variantId: regularPizza.variant.id,
          modifierSelections: regularPizza.selections,
          pizzaToppings: [{ modifierOptionId: pepperoni.option_id, portion: "whole", amount: "extra" }],
          specialInstructions: "Automated rollback-only cashier test",
        }],
      });
      const rows = await getSql()`
        SELECT item.modifier_total_cents, item.special_instructions, modifier.quantity, modifier.unit_price_delta_cents,
               modifier.pizza_topping_portion, modifier.pizza_topping_amount
        FROM ordering_order_items item
        JOIN ordering_order_item_modifiers modifier ON modifier.order_item_id = item.id AND modifier.option_id = ${pepperoni.option_id}
        WHERE item.order_id = ${order.id}
      `;
      const row = rows[0];
      modifierQuantityVerified = Number(row?.quantity) === 1
        && row?.pizza_topping_portion === "whole" && row?.pizza_topping_amount === "extra"
        && Number(row?.modifier_total_cents) === Number(row?.unit_price_delta_cents)
        && row?.special_instructions === "Automated rollback-only cashier test";
      if (!modifierQuantityVerified) throw new Error(`Modifier quantity or item-note snapshot mismatch: ${JSON.stringify(row)}.`);
      throw new Error("rollback:modifier-quantity");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "rollback:modifier-quantity") throw error;
  }

  let unavailableItemRejected = false;
  try {
    await withTransaction(async () => {
      await getSql()`UPDATE ordering_menu_items SET available = FALSE WHERE id = ${pizzaSub.menuItem.id}`;
      await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "rezku-pricing-smoke-test",
        items: [{ itemId: pizzaSub.menuItem.id, variantId: pizzaSub.variant.id, modifierSelections: pizzaSub.selections }],
      });
    });
  } catch (error) {
    unavailableItemRejected = error instanceof Error && error.message.endsWith("currently unavailable.");
  }
  if (!unavailableItemRejected) throw new Error("Unavailable menu item was not rejected.");

  const leftover = await sql`SELECT COUNT(*)::INTEGER AS count FROM ordering_orders WHERE created_by = 'rezku-pricing-smoke-test'`;
  if (Number(leftover[0].count) !== 0) throw new Error("Rollback-only pricing tests left draft orders behind.");
  console.log(JSON.stringify({
    results,
    unsupportedVariantRejected,
    missingRequiredModifierRejected,
    tooManyModifiersRejected,
    modifierQuantityVerified,
    unavailableItemRejected,
    restrictedVariants,
    draftRollbacksVerified: true,
  }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
