import { getSql } from "@/lib/db";
import { ensureOrderingMenuImportSchema } from "@/lib/ordering-menu-import-schema";

let promise: Promise<void> | null = null;

export function ensureOrderingMenuOverrideSchema(): Promise<void> {
  if (!promise) promise = (async () => {
    await ensureOrderingMenuImportSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_category_overrides (
      category_id UUID PRIMARY KEY REFERENCES ordering_menu_categories(id) ON DELETE CASCADE,
      display_name TEXT, parent_id UUID REFERENCES ordering_menu_categories(id), sort_order INTEGER,
      parent_id_overridden BOOLEAN NOT NULL DEFAULT FALSE, visible BOOLEAN,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT NOT NULL DEFAULT ''
    )`;
    await sql`ALTER TABLE ordering_category_overrides ADD COLUMN IF NOT EXISTS parent_id_overridden BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_item_overrides (
      item_id UUID PRIMARY KEY REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
      display_name TEXT, category_id UUID REFERENCES ordering_menu_categories(id), sort_order INTEGER,
      visible BOOLEAN, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT NOT NULL DEFAULT ''
    )`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_modifier_presentation_overrides (
      item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
      group_id UUID NOT NULL REFERENCES ordering_modifier_groups(id) ON DELETE CASCADE,
      context TEXT CHECK (context IN ('ordinary','combo_trigger','dependent','hidden')),
      behavior TEXT CHECK (behavior IN ('standard','pizza_topping')),
      parent_group_id UUID REFERENCES ordering_modifier_groups(id),
      parent_option_ids UUID[], sort_order INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL DEFAULT '', PRIMARY KEY (item_id, group_id)
    )`;
    await sql`ALTER TABLE ordering_modifier_presentation_overrides ADD COLUMN IF NOT EXISTS behavior TEXT`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_menu_override_audit (
      id UUID PRIMARY KEY, business TEXT NOT NULL, actor_id TEXT NOT NULL, target_type TEXT NOT NULL,
      target_id UUID NOT NULL, field_name TEXT NOT NULL, previous_value JSONB, new_value JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_menu_override_audit_target_idx ON ordering_menu_override_audit(target_type,target_id,created_at DESC)`;
    // The Rezku capture associates these source-ID groups with every meal item,
    // but does not encode its conditional display rules. Preserve the source
    // records and attach the recovered relationship only to items that contain
    // both the meal-choice parent and the corresponding child group.
    await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,parent_group_id,parent_option_ids,updated_by)
      SELECT link.item_id, link.group_id,
        CASE child.source_id WHEN '144180' THEN 'combo_trigger' ELSE 'dependent' END,
        CASE WHEN child.source_id='144180' THEN NULL ELSE parent.internal_id END,
        CASE child.source_id
          WHEN '140395' THEN ARRAY(SELECT internal_id FROM ordering_menu_source_map WHERE business='Corner Deli' AND source='rezku' AND entity_type='modifier_option' AND source_id IN ('857844','857846','857848','857850'))
          WHEN '140373' THEN ARRAY(SELECT internal_id FROM ordering_menu_source_map WHERE business='Corner Deli' AND source='rezku' AND entity_type='modifier_option' AND source_id IN ('857845','857847','857849','857851','857852'))
          ELSE NULL
        END,
        'rezku-dependency-migration'
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_source_map child ON child.business='Corner Deli' AND child.source='rezku' AND child.entity_type='modifier_group' AND child.internal_id=link.group_id AND child.source_id IN ('144180','140395','140373')
      JOIN ordering_menu_source_map parent ON parent.business='Corner Deli' AND parent.source='rezku' AND parent.entity_type='modifier_group' AND parent.source_id='144180'
      WHERE child.source_id='144180' OR EXISTS (SELECT 1 FROM ordering_menu_item_modifier_groups parent_link WHERE parent_link.item_id=link.item_id AND parent_link.group_id=parent.internal_id)
      ON CONFLICT (item_id,group_id) DO NOTHING
    `;
    await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,behavior,updated_by)
      SELECT link.item_id,link.group_id,'pizza_topping','rezku-pizza-topping-migration'
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_items item ON item.id=link.item_id AND item.business='Corner Deli'
      JOIN ordering_menu_source_map source ON source.internal_id=link.group_id AND source.business='Corner Deli' AND source.source='rezku' AND source.entity_type='modifier_group' AND source.source_id='140346'
      ON CONFLICT(item_id,group_id) DO UPDATE SET behavior='pizza_topping'
    `;
  })().catch((error) => { promise = null; throw error; });
  return promise;
}
