import { getSql } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";
import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";
import { buildBoard, seasonFor, type Board, type PriceIndex, type SeasonKey } from "@/lib/menu-board-layout";

type Row = { category: string; item: string; base_price_cents: number; available: boolean; variant: string | null; variant_cents: number | null; variant_available: boolean | null };

/** Corner Deli's active items and sizes, keyed "category|item" (lower case). */
export async function menuBoardPriceIndex(): Promise<PriceIndex> {
  await ensureOrderingSchema();
  await ensureOrderingVariantSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT COALESCE(NULLIF(c.display_name, ''), c.name) AS category, i.name AS item, i.base_price_cents, i.available,
      v.name AS variant, v.base_price_cents AS variant_cents, v.available AS variant_available
    FROM ordering_menu_items i
    JOIN ordering_menu_categories c ON c.id = i.category_id AND c.active = TRUE
    LEFT JOIN ordering_menu_item_variants v ON v.item_id = i.id AND v.active = TRUE
    WHERE i.business = 'Corner Deli' AND i.active = TRUE
    ORDER BY i.id, v.sort_order, v.name
  `) as Row[];
  const index: PriceIndex = new Map();
  for (const row of rows) {
    const key = `${row.category}|${row.item}`.toLowerCase();
    let entry = index.get(key);
    if (!entry) index.set(key, (entry = { basePriceCents: Number(row.base_price_cents), available: Boolean(row.available), variants: [] }));
    if (row.variant !== null) entry.variants.push({ name: row.variant, priceCents: Number(row.variant_cents), available: Boolean(row.variant_available) });
  }
  return index;
}

/** Today's month-day in store time, like "10-31". */
export function storeMonthDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return `${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
}

export async function menuBoard(tv: number, season?: SeasonKey): Promise<Board> {
  return buildBoard(tv, season ?? seasonFor(storeMonthDay()), await menuBoardPriceIndex());
}
