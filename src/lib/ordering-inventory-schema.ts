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
    })().catch((error) => {
      inventorySchemaPromise = null;
      throw error;
    });
  }

  return inventorySchemaPromise;
}
