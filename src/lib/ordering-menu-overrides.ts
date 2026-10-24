import { getSql } from "@/lib/db";
import { ensureOrderingMenuImportSchema } from "@/lib/ordering-menu-import-schema";

let promise: Promise<void> | null = null;

export function ensureOrderingMenuOverrideSchema(): Promise<void> {
  if (!promise)
    promise = (async () => {
      await ensureOrderingMenuImportSchema();
      const sql = getSql();
      // Nacho Supreme includes salsa on the food and sour cream on the side. Keep
      // the imported removal and paid-extra modifiers intact while making the
      // standard preparation explicit in every shared ordering channel.
      await sql`
      INSERT INTO ordering_item_overrides(item_id,description,updated_at,updated_by)
      SELECT item.id,
        'Chips with meat, cheese, lettuce, tomatoes, onions, black olives, jalapeños, and salsa, with sour cream on the side.',
        NOW(),'nacho-supreme-salsa-side'
      FROM ordering_menu_items item
      WHERE item.business='Corner Deli' AND item.name='Nacho Supreme' AND item.active=TRUE
      ON CONFLICT(item_id) DO UPDATE SET
        description=EXCLUDED.description,
        updated_at=NOW(),
        updated_by='nacho-supreme-salsa-side'
    `;
      await sql`
      INSERT INTO ordering_menu_item_modifier_defaults(id,item_id,option_id,default_selected,included_quantity,active)
      SELECT gen_random_uuid(),item.id,option.id,TRUE,1,TRUE
      FROM ordering_menu_items item
      JOIN ordering_menu_item_modifier_groups link ON link.item_id=item.id
      JOIN ordering_modifier_groups groups ON groups.id=link.group_id
      JOIN ordering_modifier_options option ON option.group_id=groups.id
      WHERE item.business='Corner Deli' AND item.name='Nacho Supreme' AND item.active=TRUE
        AND groups.name='Nacho Supreme Options' AND option.name='Side of Sour Cream'
        AND groups.active=TRUE AND option.active=TRUE AND option.available=TRUE
      ON CONFLICT(item_id,option_id) DO UPDATE SET default_selected=TRUE,included_quantity=1,active=TRUE,updated_at=NOW()
    `;
      await sql`
      INSERT INTO ordering_menu_item_modifier_defaults(id,item_id,option_id,default_selected,included_quantity,active)
      SELECT gen_random_uuid(),item.id,option.id,TRUE,1,TRUE
      FROM ordering_menu_items item
      JOIN ordering_menu_item_modifier_groups link ON link.item_id=item.id
      JOIN ordering_modifier_groups groups ON groups.id=link.group_id
      JOIN ordering_modifier_options option ON option.group_id=groups.id
      WHERE item.business='Corner Deli' AND item.name='Chicken Fajita' AND item.active=TRUE
        AND groups.name='Chicken Meat Choice' AND option.name='Grilled Chicken'
      ON CONFLICT(item_id,option_id) DO UPDATE SET default_selected=TRUE,included_quantity=1,active=TRUE,updated_at=NOW()
    `;
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
      await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,included_choice_count,updated_by) SELECT item.internal_id,grp.internal_id,1,'rezku-included-choice-migration' FROM ordering_menu_source_map item JOIN ordering_menu_source_map grp ON grp.business=item.business AND grp.source=item.source WHERE item.business='Corner Deli' AND item.source='rezku' AND item.entity_type='item' AND grp.entity_type='modifier_group' AND ((item.source_id='874189' AND grp.source_id='140367') OR (item.source_id IN ('874196','874199','874201') AND grp.source_id='140369')) ON CONFLICT(item_id,group_id) DO UPDATE SET included_choice_count=1`;
      await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,behavior,updated_by)
      SELECT link.item_id,link.group_id,'pizza_topping','rezku-pizza-topping-migration'
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_items item ON item.id=link.item_id AND item.business='Corner Deli'
      JOIN ordering_menu_source_map source ON source.internal_id=link.group_id AND source.business='Corner Deli' AND source.source='rezku' AND source.entity_type='modifier_group' AND source.source_id='140346'
      ON CONFLICT(item_id,group_id) DO UPDATE SET behavior='pizza_topping'
    `;
      // Rezku group 144183 is the imported Light/Heavy capability marker. Attach
      // that capability to the stable imported sub-topping groups on the same
      // items, then hide the legacy standalone selector.
      await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,supports_intensity,updated_by)
      SELECT topping.item_id,topping.group_id,TRUE,'rezku-sub-intensity-migration'
      FROM ordering_menu_item_modifier_groups topping
      JOIN ordering_menu_source_map topping_source ON topping_source.internal_id=topping.group_id
        AND topping_source.business='Corner Deli' AND topping_source.source='rezku'
        AND topping_source.entity_type='modifier_group' AND topping_source.source_id IN ('140351','140360')
      WHERE EXISTS (
        SELECT 1 FROM ordering_menu_item_modifier_groups marker
        JOIN ordering_menu_source_map marker_source ON marker_source.internal_id=marker.group_id
          AND marker_source.business='Corner Deli' AND marker_source.source='rezku'
          AND marker_source.entity_type='modifier_group' AND marker_source.source_id='144183'
        WHERE marker.item_id=topping.item_id
      )
      ON CONFLICT(item_id,group_id) DO UPDATE SET supports_intensity=TRUE,updated_by='rezku-sub-intensity-migration',updated_at=NOW()
    `;
      await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,updated_by)
      SELECT link.item_id,link.group_id,'hidden','rezku-sub-intensity-migration'
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_source_map source ON source.internal_id=link.group_id AND source.business='Corner Deli'
        AND source.source='rezku' AND source.entity_type='modifier_group' AND source.source_id='144183'
      ON CONFLICT(item_id,group_id) DO UPDATE SET context='hidden',updated_by='rezku-sub-intensity-migration',updated_at=NOW()
    `;
      // Explicit milestone defaults recovered from the stable Rezku IDs for the
      // real Pizza item. Source rows remain untouched; this additive presentation
      // layer is snapshotted onto each order for deterministic ticket reprints.
      await sql`
      INSERT INTO ordering_menu_item_modifier_defaults(id,item_id,option_id,default_selected,included_quantity,active)
      SELECT option.internal_id,item.internal_id,option.internal_id,TRUE,1,TRUE
      FROM ordering_menu_source_map item
      JOIN ordering_menu_source_map option ON option.business=item.business AND option.source=item.source
        AND option.entity_type='modifier_option' AND option.source_id IN ('832472','832478')
      WHERE item.business='Corner Deli' AND item.source='rezku' AND item.entity_type='item' AND item.source_id='873983'
      ON CONFLICT(item_id,option_id) DO UPDATE SET default_selected=TRUE,included_quantity=1,active=TRUE,updated_at=NOW()
    `;
      // Hot meat meals include a small salad and small fries. The included
      // dressing remains required, while explicit upgrades replace these real
      // imported defaults through each single-select group.
      await sql`
      INSERT INTO ordering_menu_item_modifier_defaults(id,item_id,option_id,default_selected,included_quantity,active)
      SELECT gen_random_uuid(),item.id,option.id,TRUE,1,TRUE
      FROM ordering_menu_items item
      JOIN ordering_menu_categories category ON category.id=item.category_id
      JOIN ordering_menu_item_modifier_groups link ON link.item_id=item.id
      JOIN ordering_modifier_groups groups ON groups.id=link.group_id
      JOIN ordering_modifier_options option ON option.group_id=groups.id
      WHERE item.business='Corner Deli' AND category.name='Meals / Hot Meat Meals'
        AND item.active=TRUE AND option.active=TRUE
        AND ((groups.name='Choose a Salad (Dinner)' AND option.name='SM Tossed Sal')
          OR (groups.name='Choose a Side' AND option.name='Small French Fries'))
        AND EXISTS (SELECT 1 FROM ordering_menu_item_modifier_groups required_link
          JOIN ordering_modifier_groups required_group ON required_group.id=required_link.group_id
          WHERE required_link.item_id=item.id AND required_group.name='Choose Dressing')
      ON CONFLICT(item_id,option_id) DO UPDATE SET default_selected=TRUE,included_quantity=1,active=TRUE,updated_at=NOW()
    `;
      await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,updated_by)
      SELECT link.item_id,link.group_id,'hidden','hot-meat-meal-defaults'
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_items item ON item.id=link.item_id AND item.business='Corner Deli'
      JOIN ordering_menu_categories category ON category.id=item.category_id AND category.name='Meals / Hot Meat Meals'
      JOIN ordering_modifier_groups groups ON groups.id=link.group_id AND groups.name='Dressing/Options'
      WHERE EXISTS (SELECT 1 FROM ordering_menu_item_modifier_groups included_link
        JOIN ordering_modifier_groups included_group ON included_group.id=included_link.group_id
        WHERE included_link.item_id=item.id AND included_group.name='Choose Dressing')
      ON CONFLICT(item_id,group_id) DO UPDATE SET context='hidden',updated_by='hot-meat-meal-defaults',updated_at=NOW()
    `;
      // Bone-in and boneless wings always require a flavor decision. Plain is
      // an explicit real option, so every ordering channel records the choice.
      await sql`
      UPDATE ordering_modifier_groups groups SET min_selections=1,updated_at=NOW()
      WHERE groups.business='Corner Deli' AND groups.name='Wing Sauce'
        AND EXISTS (
          SELECT 1 FROM ordering_menu_item_modifier_groups link
          JOIN ordering_menu_items item ON item.id=link.item_id
          WHERE link.group_id=groups.id AND item.name IN ('Wings','Boneless Wings')
        )
    `;
      await sql`
      INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,sort_order,updated_by)
      SELECT link.item_id,link.group_id,
        CASE WHEN groups.name='Wing Sauce' THEN 10 ELSE 20 END,
        'wing-sauce-before-addons'
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_items item ON item.id=link.item_id AND item.business='Corner Deli' AND item.name IN ('Wings','Boneless Wings')
      JOIN ordering_modifier_groups groups ON groups.id=link.group_id AND groups.name IN ('Wing Sauce','Wings Add Ons')
      ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `;
      // Bacon is its own repeatable burger add-on so extra bacon can be priced
      // per portion without making every ordinary burger topping repeatable.
      await sql`INSERT INTO ordering_modifier_groups(id,business,name,prompt,min_selections,max_selections,allow_option_quantity,active,sort_order) SELECT gen_random_uuid(),'Corner Deli','Burger Bacon','Add bacon?',0,10,TRUE,TRUE,900 WHERE NOT EXISTS(SELECT 1 FROM ordering_modifier_groups WHERE business='Corner Deli' AND name='Burger Bacon')`;
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),id,'Bacon',150,TRUE,TRUE,10 FROM ordering_modifier_groups WHERE business='Corner Deli' AND name='Burger Bacon' ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=150,available=TRUE,active=TRUE,updated_at=NOW()`;
      await sql`
      INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order)
      SELECT gen_random_uuid(),link.item_id,bacon.id,COALESCE(MAX(existing.sort_order),0)+10
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_modifier_groups original ON original.id=link.group_id AND original.business='Corner Deli' AND original.name='Burger Toppings'
      JOIN ordering_modifier_groups bacon ON bacon.business='Corner Deli' AND bacon.name='Burger Bacon'
      LEFT JOIN ordering_menu_item_modifier_groups existing ON existing.item_id=link.item_id
      GROUP BY link.item_id,bacon.id
      ON CONFLICT(item_id,group_id) DO NOTHING
    `;
      await sql`UPDATE ordering_modifier_options option SET active=FALSE,available=FALSE,updated_at=NOW() FROM ordering_modifier_groups groups WHERE option.group_id=groups.id AND groups.business='Corner Deli' AND groups.name='Burger Toppings' AND option.name='Bacon'`;
      // Every Big Boss comes with Swiss by default and uses Big Boss mods for
      // free American/Provolone substitutions. Salami alone inherited the
      // ordinary required sub-cheese group from the source import, which made
      // it ask a different cheese question than the other three Big Bosses.
      await sql`
      DELETE FROM ordering_menu_item_modifier_groups link
      USING ordering_menu_items item, ordering_modifier_groups groups
      WHERE link.item_id=item.id AND link.group_id=groups.id
        AND item.business='Corner Deli' AND item.name='Salami Big Boss'
        AND groups.business='Corner Deli' AND groups.name='Free Cheese'
    `;
      await sql`
      UPDATE ordering_menu_item_modifier_defaults defaults SET default_selected=FALSE,updated_at=NOW()
      FROM ordering_menu_items item,ordering_modifier_options option,ordering_modifier_groups groups
      WHERE defaults.item_id=item.id AND defaults.option_id=option.id AND option.group_id=groups.id
        AND item.business='Corner Deli' AND item.name IN ('Steak','Chicken Fajita','Hot Sausage')
        AND groups.name='Free Cheese'
    `;
      // Pizza Sub has six distinct free toppings; the imported maximum of five
      // prevented selecting the complete free build.
      await sql`UPDATE ordering_modifier_groups groups SET max_selections=9,updated_at=NOW() WHERE groups.business='Corner Deli' AND groups.name='Pizza Sub Toppings' AND EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups link JOIN ordering_menu_items item ON item.id=link.item_id WHERE link.group_id=groups.id AND item.name='Pizza Sub')`;
    })().catch((error) => {
      promise = null;
      throw error;
    });
  return promise;
}
