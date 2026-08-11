import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { orderingMenu, type OrderingMenuCategoryView, type OrderingMenuItemView } from "@/lib/ordering-menu";
import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";

export type OrderingVariantModifierPriceView = {
  optionId: string;
  priceDeltaCents: number;
  available: boolean;
};

export type OrderingItemVariantView = {
  id: string;
  name: string;
  sku: string;
  basePriceCents: number;
  defaultVariant: boolean;
  available: boolean;
  sortOrder: number;
  metadata: Record<string, unknown>;
  aliases: string[];
  modifierPrices: OrderingVariantModifierPriceView[];
};

export type OrderingMenuItemWithVariants = OrderingMenuItemView & {
  variants: OrderingItemVariantView[];
};

export type OrderingMenuCategoryWithVariants = Omit<OrderingMenuCategoryView, "items"> & {
  items: OrderingMenuItemWithVariants[];
};

type VariantRow = {
  id: string;
  item_id: string;
  name: string;
  sku: string;
  base_price_cents: number;
  default_variant: boolean;
  available: boolean;
  sort_order: number;
  metadata: Record<string, unknown> | null;
};
type AliasRow = { variant_id: string; alias: string };
type ModifierPriceRow = { variant_id: string; option_id: string; price_delta_cents: number; available: boolean };

export async function orderingMenuWithVariants(business: OrderingBusiness): Promise<OrderingMenuCategoryWithVariants[]> {
  await ensureOrderingVariantSchema();
  const categories = await orderingMenu(business);
  const sql = getSql();

  const variants = (await sql`
    SELECT variant.id, variant.item_id, variant.name, variant.sku, variant.base_price_cents,
           variant.default_variant, variant.available, variant.sort_order, variant.metadata
    FROM ordering_menu_item_variants variant
    JOIN ordering_menu_items item ON item.id = variant.item_id
    WHERE item.business = ${business} AND item.active = TRUE AND variant.active = TRUE
    ORDER BY variant.item_id, variant.sort_order, variant.name
  `) as VariantRow[];
  const variantIds = variants.map((variant) => variant.id);

  const aliases = variantIds.length
    ? (await sql`
        SELECT alias.variant_id, alias.alias
        FROM ordering_menu_variant_aliases alias
        JOIN ordering_menu_item_variants variant ON variant.id = alias.variant_id
        JOIN ordering_menu_items item ON item.id = variant.item_id
        WHERE item.business = ${business} AND alias.active = TRUE AND variant.active = TRUE
        ORDER BY alias.variant_id, alias.alias
      `) as AliasRow[]
    : [];

  const modifierPrices = variantIds.length
    ? (await sql`
        SELECT price.variant_id, price.option_id, price.price_delta_cents, price.available
        FROM ordering_menu_variant_modifier_prices price
        JOIN ordering_menu_item_variants variant ON variant.id = price.variant_id
        JOIN ordering_menu_items item ON item.id = variant.item_id
        WHERE item.business = ${business} AND price.active = TRUE AND variant.active = TRUE
      `) as ModifierPriceRow[]
    : [];

  const aliasesByVariant = new Map<string, string[]>();
  for (const row of aliases) {
    const list = aliasesByVariant.get(row.variant_id) || [];
    list.push(row.alias);
    aliasesByVariant.set(row.variant_id, list);
  }
  const pricesByVariant = new Map<string, OrderingVariantModifierPriceView[]>();
  for (const row of modifierPrices) {
    const list = pricesByVariant.get(row.variant_id) || [];
    list.push({
      optionId: row.option_id,
      priceDeltaCents: Number(row.price_delta_cents),
      available: Boolean(row.available),
    });
    pricesByVariant.set(row.variant_id, list);
  }

  const variantsByItem = new Map<string, OrderingItemVariantView[]>();
  for (const row of variants) {
    const list = variantsByItem.get(row.item_id) || [];
    list.push({
      id: row.id,
      name: row.name,
      sku: row.sku,
      basePriceCents: Number(row.base_price_cents),
      defaultVariant: Boolean(row.default_variant),
      available: Boolean(row.available),
      sortOrder: Number(row.sort_order),
      metadata: row.metadata || {},
      aliases: aliasesByVariant.get(row.id) || [],
      modifierPrices: pricesByVariant.get(row.id) || [],
    });
    variantsByItem.set(row.item_id, list);
  }

  return categories.map((category) => ({
    ...category,
    items: category.items.map((item) => ({
      ...item,
      variants: variantsByItem.get(item.id) || [],
    })),
  }));
}
