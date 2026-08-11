import { createHash, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingMenuImportSchema } from "@/lib/ordering-menu-import-schema";

export type RezkuNormalizedVariantModifierPrice = {
  modifierSourceId: string;
  priceDeltaCents: number;
  available: boolean;
};

export type RezkuNormalizedVariant = {
  sourceId: string;
  name: string;
  basePriceCents: number;
  available?: boolean;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  modifierPrices?: RezkuNormalizedVariantModifierPrice[];
};

export type RezkuNormalizedModifierOverride = {
  modifierSourceId: string;
  variantSourceId?: string | null;
  priceDeltaCents?: number | null;
  disabled?: boolean;
};

export type RezkuNormalizedItem = {
  sourceId: string;
  name: string;
  variants?: RezkuNormalizedVariant[];
  itemModifierOverrides?: RezkuNormalizedModifierOverride[];
};

export type RezkuNormalizedSnapshot = {
  source: "rezku";
  business: "Corner Deli" | "Tiki";
  categories: Array<{ sourceId: string; name: string; items: RezkuNormalizedItem[] }>;
};

type MapRow = { internal_id: string };
type PriceRow = { price_delta_cents: number };

function sourceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function mappedId(input: {
  business: RezkuNormalizedSnapshot["business"];
  entityType: string;
  sourceId: string;
}): Promise<string | null> {
  const rows = (await getSql()`
    SELECT internal_id
    FROM ordering_menu_source_map
    WHERE business = ${input.business}
      AND source = 'rezku'
      AND entity_type = ${input.entityType}
      AND source_id = ${input.sourceId}
    LIMIT 1
  `) as MapRow[];
  return rows[0]?.internal_id || null;
}

async function rememberSource(input: {
  business: RezkuNormalizedSnapshot["business"];
  entityType: "variant" | "variant_modifier_price";
  sourceId: string;
  internalId: string;
  payload: unknown;
  runId?: string | null;
}): Promise<void> {
  await getSql()`
    INSERT INTO ordering_menu_source_map (
      id, business, source, entity_type, source_id, internal_id,
      source_hash, source_payload, last_import_run_id
    ) VALUES (
      ${randomUUID()}, ${input.business}, 'rezku', ${input.entityType}, ${input.sourceId}, ${input.internalId},
      ${sourceHash(input.payload)}, CAST(${JSON.stringify(input.payload)} AS jsonb), ${input.runId || null}
    )
    ON CONFLICT (business, source, entity_type, source_id) DO UPDATE SET
      internal_id = EXCLUDED.internal_id,
      source_hash = EXCLUDED.source_hash,
      source_payload = EXCLUDED.source_payload,
      last_import_run_id = EXCLUDED.last_import_run_id,
      last_seen_at = NOW()
  `;
}

function aliasesForVariant(name: string): string[] {
  const normalized = name.trim().toLowerCase();
  if (normalized === "full sub") return ["whole", "whole sub", "full", "full sub"];
  if (normalized === "1/2 sub") return ["half", "half sub", "1/2", "1/2 sub"];
  if (normalized === "wraps") return ["wrap", "wraps"];
  return [];
}

/**
 * Applies the variant-specific part of a normalized Rezku capture after the
 * generic category/item/modifier import has established source-ID mappings.
 * Rezku reuses variation IDs (for example Full Sub) across many products, so
 * variant source keys are item-scoped: `<product id>:<variation id>`.
 */
export async function applyRezkuVariantSnapshot(input: {
  snapshot: RezkuNormalizedSnapshot;
  runId?: string | null;
}): Promise<{ variantsApplied: number; modifierPricesApplied: number; itemOverridesApplied: number }> {
  await ensureOrderingMenuImportSchema();
  const sql = getSql();
  let variantsApplied = 0;
  let modifierPricesApplied = 0;
  let itemOverridesApplied = 0;

  for (const category of input.snapshot.categories) {
    for (const item of category.items) {
      const itemId = await mappedId({ business: input.snapshot.business, entityType: "item", sourceId: item.sourceId });
      if (!itemId) throw new Error(`Rezku item ${item.sourceId} ${item.name} has not been applied to the menu yet.`);

      const variantIds = new Map<string, string>();
      for (const variant of item.variants || []) {
        const compositeSourceId = `${item.sourceId}:${variant.sourceId}`;
        let variantId = await mappedId({ business: input.snapshot.business, entityType: "variant", sourceId: compositeSourceId });
        if (variantId) {
          const rows = await sql`
            UPDATE ordering_menu_item_variants
            SET name = ${variant.name.trim()},
                base_price_cents = ${Math.max(0, Math.trunc(variant.basePriceCents))},
                available = ${variant.available !== false},
                active = TRUE,
                sort_order = ${Math.trunc(variant.sortOrder ?? 0)},
                metadata = CAST(${JSON.stringify(variant.metadata || {})} AS jsonb),
                updated_at = NOW()
            WHERE id = ${variantId} AND item_id = ${itemId}
            RETURNING id
          `;
          if (!rows.length) variantId = null;
        }
        if (!variantId) {
          const rows = await sql`
            INSERT INTO ordering_menu_item_variants (
              id, item_id, name, base_price_cents, default_variant, available, active, sort_order, metadata
            ) VALUES (
              ${randomUUID()}, ${itemId}, ${variant.name.trim()}, ${Math.max(0, Math.trunc(variant.basePriceCents))},
              FALSE, ${variant.available !== false}, TRUE, ${Math.trunc(variant.sortOrder ?? 0)},
              CAST(${JSON.stringify(variant.metadata || {})} AS jsonb)
            )
            ON CONFLICT (item_id, name) DO UPDATE SET
              base_price_cents = EXCLUDED.base_price_cents,
              available = EXCLUDED.available,
              active = TRUE,
              sort_order = EXCLUDED.sort_order,
              metadata = EXCLUDED.metadata,
              updated_at = NOW()
            RETURNING id
          `;
          variantId = rows[0].id as string;
        }
        variantIds.set(variant.sourceId, variantId);
        await rememberSource({ business: input.snapshot.business, entityType: "variant", sourceId: compositeSourceId, internalId: variantId, payload: variant, runId: input.runId });

        for (const alias of aliasesForVariant(variant.name)) {
          await sql`
            INSERT INTO ordering_menu_variant_aliases (id, variant_id, alias, normalized_alias, active)
            VALUES (${randomUUID()}, ${variantId}, ${alias}, ${alias.trim().toLowerCase()}, TRUE)
            ON CONFLICT (variant_id, normalized_alias) DO UPDATE SET alias = EXCLUDED.alias, active = TRUE
          `;
        }

        for (const modifierPrice of variant.modifierPrices || []) {
          const optionId = await mappedId({ business: input.snapshot.business, entityType: "modifier_option", sourceId: modifierPrice.modifierSourceId });
          if (!optionId) continue;
          const rows = await sql`
            INSERT INTO ordering_menu_variant_modifier_prices (
              id, variant_id, option_id, price_delta_cents, available, active
            ) VALUES (
              ${randomUUID()}, ${variantId}, ${optionId}, ${Math.trunc(modifierPrice.priceDeltaCents)},
              ${modifierPrice.available !== false}, TRUE
            )
            ON CONFLICT (variant_id, option_id) DO UPDATE SET
              price_delta_cents = EXCLUDED.price_delta_cents,
              available = EXCLUDED.available,
              active = TRUE,
              updated_at = NOW()
            RETURNING id
          `;
          const priceId = rows[0].id as string;
          await rememberSource({
            business: input.snapshot.business,
            entityType: "variant_modifier_price",
            sourceId: `${compositeSourceId}:${modifierPrice.modifierSourceId}`,
            internalId: priceId,
            payload: modifierPrice,
            runId: input.runId,
          });
          modifierPricesApplied += 1;
        }
        variantsApplied += 1;
      }

      // Product-specific overrides are applied after global variation pricing.
      // A null variation applies to the item in every form; a variation-scoped
      // override only affects that one item's matching variant.
      for (const override of item.itemModifierOverrides || []) {
        const optionId = await mappedId({ business: input.snapshot.business, entityType: "modifier_option", sourceId: override.modifierSourceId });
        if (!optionId) continue;
        if (!override.variantSourceId) {
          await sql`
            INSERT INTO ordering_menu_item_modifier_defaults (
              id, item_id, option_id, default_selected, included_quantity,
              price_delta_override_cents, available_override, active
            ) VALUES (
              ${randomUUID()}, ${itemId}, ${optionId}, FALSE, 0,
              ${override.priceDeltaCents == null ? null : Math.trunc(override.priceDeltaCents)},
              ${!override.disabled}, TRUE
            )
            ON CONFLICT (item_id, option_id) DO UPDATE SET
              price_delta_override_cents = COALESCE(EXCLUDED.price_delta_override_cents, ordering_menu_item_modifier_defaults.price_delta_override_cents),
              available_override = EXCLUDED.available_override,
              active = TRUE,
              updated_at = NOW()
          `;
          itemOverridesApplied += 1;
          continue;
        }

        const variantId = variantIds.get(override.variantSourceId);
        if (!variantId) continue;
        let price = override.priceDeltaCents;
        if (price == null) {
          const existing = (await sql`
            SELECT price_delta_cents
            FROM ordering_menu_variant_modifier_prices
            WHERE variant_id = ${variantId} AND option_id = ${optionId} AND active = TRUE
            LIMIT 1
          `) as PriceRow[];
          if (existing[0]) price = Number(existing[0].price_delta_cents);
          else {
            const base = (await sql`SELECT price_delta_cents FROM ordering_modifier_options WHERE id = ${optionId} LIMIT 1`) as PriceRow[];
            price = Number(base[0]?.price_delta_cents || 0);
          }
        }
        await sql`
          INSERT INTO ordering_menu_variant_modifier_prices (
            id, variant_id, option_id, price_delta_cents, available, active
          ) VALUES (${randomUUID()}, ${variantId}, ${optionId}, ${Math.trunc(price)}, ${!override.disabled}, TRUE)
          ON CONFLICT (variant_id, option_id) DO UPDATE SET
            price_delta_cents = EXCLUDED.price_delta_cents,
            available = EXCLUDED.available,
            active = TRUE,
            updated_at = NOW()
        `;
        itemOverridesApplied += 1;
      }
    }
  }

  return { variantsApplied, modifierPricesApplied, itemOverridesApplied };
}
