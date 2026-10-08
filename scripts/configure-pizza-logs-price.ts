import { getSql } from "@/lib/db";
import { ensureOrderingMenuEditorSchema } from "@/lib/ordering-menu-editor-schema";
import { mutateMenu } from "@/lib/ordering-menu-editor";

async function main() {
  await ensureOrderingMenuEditorSchema();
  const sql = getSql();
  const items = await sql`
    SELECT id FROM ordering_menu_items
    WHERE business='Corner Deli' AND LOWER(name)='pizza logs' AND active=TRUE
  `;
  if (items.length !== 1) throw new Error(`Expected one active Pizza Logs item; found ${items.length}.`);
  const actor = { id: "pizza-logs-price-2026-09", business: "Corner Deli" as const };
  await mutateMenu(actor, { action: "update", entity: "item", id: items[0].id, patch: { basePriceCents: 1000 }, reason: "Pizza Logs price updated to $10" });
  const variants = await sql`SELECT id FROM ordering_menu_item_variants WHERE item_id=${items[0].id} AND active=TRUE`;
  for (const variant of variants)
    await mutateMenu(actor, { action: "update", entity: "variant", id: variant.id, patch: { basePriceCents: 1000 }, reason: "Pizza Logs price updated to $10" });
  console.log(JSON.stringify({ itemId: items[0].id, variantIds: variants.map((row) => row.id), priceCents: 1000 }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
