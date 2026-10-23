import { getSql } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";
import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";
import { createHash } from "node:crypto";
import { buildBoard, seasonFor, MENU_SCREENS, MENU_TVS, PROMOS, SEASONS, SLOT_SECONDS, TICKER, type Board, type PriceIndex, type SeasonKey } from "@/lib/menu-board-layout";

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
  // Modifier option prices by size (pizza toppings), for the groups linked to each item.
  const options = (await sql`
    SELECT COALESCE(NULLIF(c.display_name, ''), c.name) AS category, i.name AS item, g.name AS grp, o.name AS option, o.sort_order,
      o.available AND o.active AS available, v.name AS variant, COALESCE(p.price_delta_cents, o.price_delta_cents) AS cents
    FROM ordering_menu_items i
    JOIN ordering_menu_categories c ON c.id = i.category_id AND c.active = TRUE
    JOIN ordering_menu_item_modifier_groups l ON l.item_id = i.id
    JOIN ordering_modifier_groups g ON g.id = l.group_id AND g.active = TRUE
    JOIN ordering_modifier_options o ON o.group_id = g.id AND o.active = TRUE
    JOIN ordering_menu_item_variants v ON v.item_id = i.id AND v.active = TRUE
    LEFT JOIN ordering_menu_variant_modifier_prices p ON p.variant_id = v.id AND p.option_id = o.id AND p.active = TRUE
    WHERE i.business = 'Corner Deli' AND i.active = TRUE
    ORDER BY o.sort_order, o.name
  `) as { category: string; item: string; grp: string; option: string; available: boolean; variant: string; cents: number }[];
  for (const row of options) {
    const entry = index.get(`${row.category}|${row.item}`.toLowerCase());
    if (!entry) continue;
    const group = ((entry.modifiers ??= {})[row.grp.toLowerCase()] ??= []);
    let option = group.find((o) => o.name === row.option);
    if (!option) group.push((option = { name: row.option, available: Boolean(row.available), prices: {} }));
    option.prices[row.variant.toLowerCase()] = Number(row.cents);
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

/**
 * Changes when the screens, promos or TVs are edited (a new release), not when a price does. A TV
 * whose page was loaded before that reloads, so it never draws new board data with old page code.
 */
export const MENU_LAYOUT_VERSION = createHash("sha1").update(JSON.stringify([MENU_SCREENS, PROMOS, MENU_TVS, SEASONS, SLOT_SECONDS, TICKER])).digest("hex").slice(0, 12);
