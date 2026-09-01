import { getSql } from "@/lib/db";
import { ensureSchema } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";

let inventorySchemaPromise: Promise<void> | null = null;

/**
 * Inventory foundation for POS adjustments, receiving, physical counts, and
 * future recipe/menu depletion. The movement ledger is authoritative; callers
 * should reverse incorrect movements rather than deleting history.
 */
export function ensureOrderingInventorySchema(): Promise<void> {
  if (!inventorySchemaPromise) {
    inventorySchemaPromise = (async () => {
      await ensureSchema();
      await ensureOrderingSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_inventory_locations (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_inventory_items (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          sku TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          base_unit TEXT NOT NULL DEFAULT 'each',
          estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0),
          reorder_point NUMERIC(14,3),
          track_quantity BOOLEAN NOT NULL DEFAULT TRUE,
          allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name),
          CHECK (reorder_point IS NULL OR reorder_point >= 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_items_business_idx ON ordering_inventory_items (business, active, category, name)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_items_sku_idx ON ordering_inventory_items (business, sku) WHERE sku <> ''`;
      await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS par_quantity NUMERIC(14,3)`;
      await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS case_pack_quantity NUMERIC(14,3)`;
      await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS preferred_supplier TEXT NOT NULL DEFAULT ''`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_inventory_item_locations (
          id UUID PRIMARY KEY,
          inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id) ON DELETE CASCADE,
          location_id UUID NOT NULL REFERENCES ordering_inventory_locations(id) ON DELETE CASCADE,
          is_default BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (inventory_item_id, location_id)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_inventory_movements (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),
          location_id UUID REFERENCES ordering_inventory_locations(id),
          delta_quantity NUMERIC(14,3) NOT NULL,
          unit TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (reason IN (
            'sale',
            'received',
            'owner_use',
            'employee_use',
            'employee_meal',
            'damaged',
            'spilled',
            'spoilage',
            'waste',
            'theft_or_missing',
            'count_correction',
            'transfer_in',
            'transfer_out',
            'return_to_stock',
            'comp',
            'reversal',
            'other'
          )),
          order_id UUID REFERENCES ordering_orders(id),
          employee_id UUID REFERENCES employees(id),
          time_entry_id UUID REFERENCES time_entries(id),
          related_movement_id UUID REFERENCES ordering_inventory_movements(id),
          estimated_unit_cost_cents INTEGER CHECK (estimated_unit_cost_cents IS NULL OR estimated_unit_cost_cents >= 0),
          note TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'pos',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          CHECK (delta_quantity <> 0)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_movements_item_idx ON ordering_inventory_movements (inventory_item_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_movements_business_reason_idx ON ordering_inventory_movements (business, reason, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_movements_employee_idx ON ordering_inventory_movements (employee_id, created_at DESC) WHERE employee_id IS NOT NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_inventory_counts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),
          location_id UUID REFERENCES ordering_inventory_locations(id),
          expected_quantity NUMERIC(14,3) NOT NULL,
          counted_quantity NUMERIC(14,3) NOT NULL,
          variance_quantity NUMERIC(14,3) NOT NULL,
          adjustment_movement_id UUID REFERENCES ordering_inventory_movements(id),
          counted_by TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (expected_quantity >= 0),
          CHECK (counted_quantity >= 0),
          CHECK (variance_quantity = counted_quantity - expected_quantity)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_counts_item_idx ON ordering_inventory_counts (inventory_item_id, counted_at DESC)`;
      await sql`ALTER TABLE ordering_inventory_counts DROP CONSTRAINT IF EXISTS ordering_inventory_counts_expected_quantity_check`;

      // Link sellable menu items/modifier options to stock items. Quantity usage
      // is deliberately configurable so automatic depletion only occurs when a
      // reliable mapping exists.
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_inventory_links (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          menu_item_id UUID REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
          modifier_option_id UUID REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,
          inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),
          quantity_used NUMERIC(14,3) NOT NULL CHECK (quantity_used > 0),
          unit TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK ((menu_item_id IS NOT NULL) <> (modifier_option_id IS NOT NULL))
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_inventory_links_menu_idx ON ordering_menu_inventory_links (menu_item_id, active) WHERE menu_item_id IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_inventory_links_modifier_idx ON ordering_menu_inventory_links (modifier_option_id, active) WHERE modifier_option_id IS NOT NULL`;
      await sql`ALTER TABLE ordering_inventory_movements ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES ordering_order_items(id)`;
      await sql`ALTER TABLE ordering_inventory_movements ADD COLUMN IF NOT EXISTS inventory_link_id UUID REFERENCES ordering_menu_inventory_links(id)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_inventory_sale_depletion_once ON ordering_inventory_movements(order_item_id,inventory_link_id) WHERE reason='sale' AND order_item_id IS NOT NULL AND inventory_link_id IS NOT NULL`;

      await sql`CREATE TABLE IF NOT EXISTS ordering_inventory_suppliers(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),name TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',minimum_order_cents INTEGER NOT NULL DEFAULT 0,delivery_fee_cents INTEGER NOT NULL DEFAULT 0,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(business,name))`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_inventory_supplier_items(id UUID PRIMARY KEY,supplier_id UUID NOT NULL REFERENCES ordering_inventory_suppliers(id) ON DELETE CASCADE,inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id) ON DELETE CASCADE,vendor_sku TEXT NOT NULL DEFAULT '',case_quantity NUMERIC(14,3) NOT NULL DEFAULT 1,case_unit TEXT NOT NULL DEFAULT 'each',case_price_cents INTEGER NOT NULL DEFAULT 0,last_quoted_at TIMESTAMPTZ,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(supplier_id,inventory_item_id))`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_inventory_purchase_orders(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),supplier_id UUID NOT NULL REFERENCES ordering_inventory_suppliers(id),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','ordered','partially_received','received','cancelled')),ordered_at TIMESTAMPTZ,received_at TIMESTAMPTZ,created_by TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_inventory_purchase_order_lines(id UUID PRIMARY KEY,purchase_order_id UUID NOT NULL REFERENCES ordering_inventory_purchase_orders(id) ON DELETE CASCADE,inventory_item_id UUID NOT NULL REFERENCES ordering_inventory_items(id),quantity_cases NUMERIC(14,3) NOT NULL CHECK(quantity_cases>0),case_quantity NUMERIC(14,3) NOT NULL CHECK(case_quantity>0),case_unit TEXT NOT NULL,case_price_cents INTEGER NOT NULL CHECK(case_price_cents>=0),received_cases NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK(received_cases>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    })().catch((error) => {
      inventorySchemaPromise = null;
      throw error;
    });
  }

  return inventorySchemaPromise;
}
