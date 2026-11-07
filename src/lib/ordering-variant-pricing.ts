import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";

export type ResolvedItemVariant = {
  variantId: string | null;
  variantName: string;
  variantSku: string;
  basePriceCents: number;
  modifierPrices: Map<string, { priceDeltaCents: number; available: boolean }>;
};

type ItemRow = { id: string; base_price_cents: number; available: boolean };
type VariantRow = {
  id: string;
  name: string;
  sku: string;
  base_price_cents: number;
  default_variant: boolean;
  available: boolean;
};
type ModifierPriceRow = { option_id: string; price_delta_cents: number; available: boolean };

/**
 * Resolves the base price and per-modifier overrides for one selected variant.
 * If an item has more than one active variant, callers must explicitly select
 * one. That keeps a caller saying "Turkey sub" from silently becoming a Whole
 * when Half / Whole / Wrap are all valid choices.
 */
export async function resolveItemVariantPricing(input: {
  business: OrderingBusiness;
  itemId: string;
  variantId?: string | null;
}): Promise<ResolvedItemVariant> {
  await ensureOrderingVariantSchema();
  const sql = getSql();
  const items = (await sql`
    SELECT id, base_price_cents, available
    FROM ordering_menu_items
    WHERE id = ${input.itemId} AND business = ${input.business} AND active = TRUE
    LIMIT 1
  `) as ItemRow[];
  const item = items[0];
  if (!item) throw new Error("Menu item was not found for this business.");
  if (!item.available) throw new Error("This menu item is currently unavailable.");

  const variants = (await sql`
    SELECT id, name, sku, base_price_cents, default_variant, available
    FROM ordering_menu_item_variants
    WHERE item_id = ${input.itemId} AND active = TRUE
    ORDER BY sort_order, name
  `) as VariantRow[];

  if (!variants.length) {
    if (input.variantId) throw new Error("This item does not support the selected size or form.");
    return {
      variantId: null,
      variantName: "",
      variantSku: "",
      basePriceCents: Number(item.base_price_cents),
      modifierPrices: new Map(),
    };
  }

  let variant: VariantRow | undefined;
  if (input.variantId) {
    variant = variants.find((candidate) => candidate.id === input.variantId);
    if (!variant) throw new Error("The selected size or form is not available for this item.");
  } else if (variants.length === 1) {
    variant = variants[0];
  } else {
    throw new Error("Choose a size or form before adding this item.");
  }
  if (!variant.available) throw new Error(`${variant.name} is currently unavailable.`);

  const prices = (await sql`
    SELECT option_id, price_delta_cents, available
    FROM ordering_menu_variant_modifier_prices
    WHERE variant_id = ${variant.id} AND active = TRUE
  `) as ModifierPriceRow[];
  return {
    variantId: variant.id,
    variantName: variant.name,
    variantSku: variant.sku,
    basePriceCents: Number(variant.base_price_cents),
    modifierPrices: new Map(prices.map((row) => [row.option_id, {
      priceDeltaCents: Number(row.price_delta_cents),
      available: Boolean(row.available),
    }])),
  };
}
