import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { ensureSchema, getSql } from "@/lib/db";

let schemaPromise: Promise<void> | null = null;

export function ensureFinanceOperationsSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await Promise.all([ensureSchema(), ensureAccountingControlSchema()]);
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS forecast_events (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          event_date DATE NOT NULL,
          description TEXT NOT NULL,
          amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
          direction TEXT NOT NULL CHECK (direction IN ('Inflow', 'Outflow')),
          recurrence TEXT NOT NULL DEFAULT 'None' CHECK (recurrence IN ('None', 'Weekly', 'Monthly')),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS forecast_events_business_date_idx ON forecast_events (business, event_date, active)`;

      await sql`
        CREATE TABLE IF NOT EXISTS inventory_items (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          base_unit TEXT NOT NULL DEFAULT 'each',
          par_quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
          current_quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
          reorder_point NUMERIC(14,4) NOT NULL DEFAULT 0,
          preferred_vendor TEXT NOT NULL DEFAULT '',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS inventory_items_business_active_idx ON inventory_items (business, active, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS vendor_bills (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          vendor TEXT NOT NULL,
          invoice_number TEXT NOT NULL DEFAULT '',
          invoice_date DATE NOT NULL,
          due_date DATE NOT NULL,
          subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
          tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
          total_amount NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
          category TEXT NOT NULL DEFAULT 'Other Expense',
          account_code TEXT NOT NULL DEFAULT '5900',
          status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Draft', 'Open', 'Paid', 'Void')),
          notes TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL DEFAULT '',
          content_type TEXT NOT NULL DEFAULT '',
          blob_url TEXT NOT NULL DEFAULT '',
          blob_pathname TEXT NOT NULL DEFAULT '',
          paid_bank_transaction_id UUID REFERENCES bank_transactions(id) ON DELETE SET NULL,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS vendor_bills_business_due_idx ON vendor_bills (business, status, due_date)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS vendor_bills_invoice_unique ON vendor_bills (business, LOWER(vendor), invoice_number) WHERE invoice_number <> '' AND status <> 'Void'`;

      await sql`
        CREATE TABLE IF NOT EXISTS vendor_bill_lines (
          id UUID PRIMARY KEY,
          bill_id UUID NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
          line_number INTEGER NOT NULL,
          inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
          description TEXT NOT NULL,
          quantity NUMERIC(14,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
          unit TEXT NOT NULL DEFAULT 'each',
          unit_price NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
          line_total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
          UNIQUE (bill_id, line_number)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS vendor_bill_lines_bill_idx ON vendor_bill_lines (bill_id, line_number)`;

      await sql`
        CREATE TABLE IF NOT EXISTS inventory_purchases (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
          vendor TEXT NOT NULL,
          purchase_date DATE NOT NULL,
          quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
          unit TEXT NOT NULL,
          unit_price NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0),
          total_amount NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
          bill_id UUID REFERENCES vendor_bills(id) ON DELETE SET NULL,
          source TEXT NOT NULL DEFAULT 'Manual',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS inventory_purchases_item_date_idx ON inventory_purchases (inventory_item_id, purchase_date DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS inventory_purchases_business_vendor_idx ON inventory_purchases (business, vendor, purchase_date DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS recipes (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          product_name TEXT NOT NULL,
          yield_quantity NUMERIC(14,4) NOT NULL DEFAULT 1 CHECK (yield_quantity > 0),
          selling_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, product_name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS recipes_business_active_idx ON recipes (business, active, product_name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS recipe_components (
          id UUID PRIMARY KEY,
          recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
          inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
          quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
          unit TEXT NOT NULL,
          waste_percent NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (waste_percent >= 0 AND waste_percent < 100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (recipe_id, inventory_item_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS recipe_components_recipe_idx ON recipe_components (recipe_id)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}
