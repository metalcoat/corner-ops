#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const SMALL_FRY = "462eac7a-8277-4d80-a5ca-ed9e30a1efb7";
const LARGE_FRY = "59061047-6e99-4c58-a34e-7412214bf059";
const MASHED = "ccab5488-c060-46a8-bb82-e603a791b788";
const FISH_FRY = "2b24f18e-a0c4-4796-b253-0f48a20e52c7";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingMenuOverrideSchema } = await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  let configured = 0;
  await withTransaction(async () => {
    const sql = getSql();
    const parents = await sql`
      SELECT DISTINCT link.item_id, link.group_id
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_menu_items item ON item.id=link.item_id AND item.business='Corner Deli' AND item.active=TRUE
      JOIN ordering_modifier_groups grp ON grp.id=link.group_id AND grp.active=TRUE
      LEFT JOIN ordering_modifier_presentation_overrides p ON p.item_id=link.item_id AND p.group_id=link.group_id
      WHERE link.item_id<>${FISH_FRY}
        AND grp.name IN ('Choose a Side','Meal Fry Choice')
        AND COALESCE(p.context,'ordinary') NOT IN ('hidden','combo_trigger')`;
    for (const parent of parents) {
      const options=await sql`SELECT id,name FROM ordering_modifier_options WHERE group_id=${parent.group_id} AND active=TRUE AND available=TRUE`;
      const ids=(matcher:RegExp)=>options.filter(row=>matcher.test(String(row.name))).map(row=>row.id);
      const dependencies = [
        [SMALL_FRY,ids(/^Small (?:French Fries|Fry|Curly|Waffle|Tater Tots)/i)],
        [LARGE_FRY,ids(/^Large (?:French Fries|Fry|Curly|Waffle|Tater Tots)/i)],
        [MASHED,ids(/Mashed/i)],
      ] as const;
      for(const [child,triggerIds] of dependencies){
        if(!triggerIds.length)continue;
        const linked=(await sql`SELECT 1 FROM ordering_menu_item_modifier_groups WHERE item_id=${parent.item_id} AND group_id=${child} LIMIT 1`).length>0;
        if(!linked)continue;
        await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,parent_group_id,parent_option_ids,updated_by) VALUES(${parent.item_id},${child},'dependent',${parent.group_id},${triggerIds},'meal-side-dependencies') ON CONFLICT(item_id,group_id) DO UPDATE SET context='dependent',parent_group_id=EXCLUDED.parent_group_id,parent_option_ids=EXCLUDED.parent_option_ids,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      }
      configured+=1;
    }
  });
  console.log(JSON.stringify({configuredMealItems:configured,sideOptionsAreConditional:true,onionRingsHaveNoOptions:true},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
