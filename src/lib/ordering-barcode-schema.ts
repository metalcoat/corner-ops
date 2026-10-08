import { getSql } from "@/lib/db";
import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";

let schemaPromise: Promise<void> | null = null;

export async function ensureOrderingBarcodeSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = (async () => {
    await ensureOrderingVariantSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_barcode_mappings (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      barcode TEXT NOT NULL,
      barcode_format TEXT NOT NULL CHECK (barcode_format IN ('upc_a','ean_8','ean_13','gtin_14','code_128_text')),
      item_id UUID NOT NULL REFERENCES ordering_menu_items(id),
      variant_id UUID REFERENCES ordering_menu_item_variants(id),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_barcode_one_active_idx ON ordering_barcode_mappings (business, barcode) WHERE active=TRUE`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_barcode_target_idx ON ordering_barcode_mappings (business,item_id,variant_id,active)`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_barcode_audit (
      id UUID PRIMARY KEY,
      mapping_id UUID NOT NULL REFERENCES ordering_barcode_mappings(id),
      business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      action TEXT NOT NULL CHECK (action IN ('created','updated','activated','deactivated')),
      barcode TEXT NOT NULL,
      before_state JSONB,
      after_state JSONB,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_barcode_audit_mapping_idx ON ordering_barcode_audit(mapping_id,created_at DESC)`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}
