import { getSql } from "@/lib/db";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";

let variantSchemaPromise: Promise<void> | null = null;

/**
 * Item variants keep one logical menu item while allowing selectable sizes/forms
 * to change both the base price and modifier pricing. Examples are pizza sizes
 * and Half / Whole / Wrap sub forms. A variant only exists on items that truly
 * support it, so an ineligible sub simply has no Wrap variant for any client to
 * offer or accept.
 */
export function ensureOrderingVariantSchema(): Promise<void> {
  if (!variantSchemaPromise) {
    variantSchemaPromise = (async () => {
      await ensureOrderingChannelSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_item_variants (
          id UUID PRIMARY KEY,
          item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sku TEXT NOT NULL DEFAULT '',
          base_price_cents INTEGER NOT NULL CHECK (base_price_cents >= 0),
          default_variant BOOLEAN NOT NULL DEFAULT FALSE,
          available BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (item_id, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_item_variants_item_idx ON ordering_menu_item_variants (item_id, active, available, sort_order, name)`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS ordering_menu_item_one_default_variant_idx
        ON ordering_menu_item_variants (item_id)
        WHERE default_variant = TRUE AND active = TRUE
      `;

      // A modifier can cost differently by variant. The base modifier option
      // remains the fallback, while these rows override it for one item/variant.
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_variant_modifier_prices (
          id UUID PRIMARY KEY,
          variant_id UUID NOT NULL REFERENCES ordering_menu_item_variants(id) ON DELETE CASCADE,
          option_id UUID NOT NULL REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,
          price_delta_cents INTEGER NOT NULL DEFAULT 0,
          available BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (variant_id, option_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_variant_modifier_prices_lookup_idx ON ordering_menu_variant_modifier_prices (variant_id, option_id, active)`;

      // Historical order lines snapshot the selected variant name and price.
      // The existing unit_price_cents remains the authoritative base-price
      // snapshot for the selected variant at the moment the order was placed.
      await sql`ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES ordering_menu_item_variants(id)`;
      await sql`ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS variant_name_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS variant_sku_snapshot TEXT NOT NULL DEFAULT ''`;
    })().catch((error) => {
      variantSchemaPromise = null;
      throw error;
    });
  }

  return variantSchemaPromise;
}
