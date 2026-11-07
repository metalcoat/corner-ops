// Custom POS line items. Pure, so it is unit-tested.
export type CustomItemInput = { name: string; priceCents: number; quantity: number; note: string };

/** Prices include tax like every menu price; $0 is allowed. */
export function parseCustomItems(value: unknown): CustomItemInput[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Custom items are not valid.");
  return value.map((raw) => {
    const row = (raw || {}) as Record<string, unknown>;
    const name = String(row.name || "").trim(), note = String(row.note || "").trim(), priceCents = Number(row.priceCents), quantity = Number(row.quantity ?? 1);
    if (!name || name.length > 80) throw new Error("Enter a custom item name (80 characters or fewer).");
    if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100000) throw new Error("Enter a custom item price from $0 to $1,000.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("Custom item quantity must be 1 to 99.");
    if (note.length > 200) throw new Error("A custom item note must be 200 characters or fewer.");
    return { name, priceCents, quantity, note };
  });
}
