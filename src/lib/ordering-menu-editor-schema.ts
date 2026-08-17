import { getSql } from "@/lib/db";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

let promise: Promise<void> | null = null;

/** Local field ownership prevents a later bootstrap import from overwriting a
 * deliberate Corner Ops edit while retaining the imported payload for reset. */
export function ensureOrderingMenuEditorSchema(): Promise<void> {
  if (!promise) promise = (async () => {
    await ensureOrderingMenuOverrideSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_menu_local_fields (
      business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      entity_type TEXT NOT NULL CHECK (entity_type IN ('category','item','variant','modifier_group','modifier_option')),
      entity_id UUID NOT NULL,
      field_name TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(entity_type,entity_id,field_name)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_menu_local_fields_business_idx ON ordering_menu_local_fields(business,entity_type,entity_id)`;
    await sql`ALTER TABLE ordering_menu_override_audit ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT ''`;
  })().catch(error => { promise = null; throw error; });
  return promise;
}
