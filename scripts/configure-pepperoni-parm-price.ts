#!/usr/bin/env node
// Chris 2026-11-06: the Pepperoni Chicken Parmesan Sub is $12.50 (was $11.50). Menu prices include tax.
// Rerunnable: rows already at $12.50 are left alone.
//
//   npx tsx scripts/configure-pepperoni-parm-price.ts                 dev
//   VALIDATION_TARGET=staging npx tsx scripts/configure-pepperoni-parm-price.ts
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const PRICE_CENTS = 1250;
const REASON = "Chris 2026-11-06: Pepperoni Chicken Parmesan Sub $12.50 (was $11.50)";

async function main() {
  const [{ getSql }, { ensureOrderingMenuEditorSchema }, { mutateMenu }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-menu-editor-schema"),
    import("../src/lib/ordering-menu-editor"),
  ]);
  await ensureOrderingMenuEditorSchema();
  const sql = getSql();
  const items = await sql`
    SELECT id, base_price_cents FROM ordering_menu_items
    WHERE business = 'Corner Deli' AND LOWER(name) = 'pepperoni chicken parmesan sub' AND active = TRUE
  `;
  if (items.length !== 1) throw new Error(`Expected one active Pepperoni Chicken Parmesan Sub; found ${items.length}.`);
  const actor = { id: "pepperoni-parm-price-2026-11", business: "Corner Deli" as const };
  const changed: Array<{ entity: string; id: string; fromCents: number }> = [];
  if (Number(items[0].base_price_cents) !== PRICE_CENTS) {
    await mutateMenu(actor, { action: "update", entity: "item", id: items[0].id, patch: { basePriceCents: PRICE_CENTS }, reason: REASON });
    changed.push({ entity: "item", id: items[0].id, fromCents: Number(items[0].base_price_cents) });
  }
  const variants = await sql`SELECT id, name, base_price_cents FROM ordering_menu_item_variants WHERE item_id = ${items[0].id} AND active = TRUE`;
  for (const variant of variants)
    if (Number(variant.base_price_cents) !== PRICE_CENTS) {
      await mutateMenu(actor, { action: "update", entity: "variant", id: variant.id, patch: { basePriceCents: PRICE_CENTS }, reason: REASON });
      changed.push({ entity: `variant ${variant.name}`, id: variant.id, fromCents: Number(variant.base_price_cents) });
    }
  console.log(JSON.stringify({ itemId: items[0].id, priceCents: PRICE_CENTS, changed }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
