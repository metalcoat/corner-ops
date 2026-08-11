import { getSql } from "@/lib/db";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";

let menuImportSchemaPromise: Promise<void> | null = null;

/**
 * Tracks one-time/external menu migrations without coupling the live menu model
 * to Rezku. Imported records keep their source IDs so repeated development
 * imports can update the same internal records rather than duplicating them.
 */
export function ensureOrderingMenuImportSchema(): Promise<void> {
  if (!menuImportSchemaPromise) {
    menuImportSchemaPromise = (async () => {
      await ensureOrderingChannelSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_import_runs (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          source TEXT NOT NULL CHECK (source IN ('rezku', 'csv', 'json', 'manual')),
          source_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'approved', 'applied', 'failed', 'cancelled')),
          category_count INTEGER NOT NULL DEFAULT 0 CHECK (category_count >= 0),
          item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
          modifier_group_count INTEGER NOT NULL DEFAULT 0 CHECK (modifier_group_count >= 0),
          modifier_option_count INTEGER NOT NULL DEFAULT 0 CHECK (modifier_option_count >= 0),
          warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
          snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT NOT NULL,
          approved_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          approved_at TIMESTAMPTZ,
          applied_at TIMESTAMPTZ,
          error_message TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_import_runs_business_idx ON ordering_menu_import_runs (business, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_source_map (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          source TEXT NOT NULL CHECK (source IN ('rezku', 'csv', 'json', 'manual')),
          entity_type TEXT NOT NULL CHECK (entity_type IN ('category', 'item', 'modifier_group', 'modifier_option', 'combo', 'combo_group', 'combo_option')),
          source_id TEXT NOT NULL,
          internal_id UUID NOT NULL,
          source_hash TEXT NOT NULL DEFAULT '',
          source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          last_import_run_id UUID REFERENCES ordering_menu_import_runs(id) ON DELETE SET NULL,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, source, entity_type, source_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_source_map_internal_idx ON ordering_menu_source_map (entity_type, internal_id)`;
    })().catch((error) => {
      menuImportSchemaPromise = null;
      throw error;
    });
  }

  return menuImportSchemaPromise;
}
