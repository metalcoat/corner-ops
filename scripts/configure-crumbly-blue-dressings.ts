#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const SALAD="616994ef-6c0a-4f3f-b787-38abc7a481c9",SMALL="ffe07150-85f5-4f6c-9c24-019de8a1f562",LARGE="2d69bb22-8f82-40c8-b278-3feeb13d1e66",LARGE_DRESSING="a18f597f-41ba-458f-a9df-f2cb112d8235";

async function main(){
  const {getSql,withTransaction}=await import("../src/lib/db");
  const {ensureOrderingMenuOverrideSchema}=await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  let sideMeals=0;
  await withTransaction(async()=>{
    const sql=getSql();
    await sql`UPDATE ordering_modifier_groups SET allow_option_quantity=TRUE,max_selections=6,updated_at=NOW() WHERE id IN (${SMALL},${LARGE},${LARGE_DRESSING})`;
    await sql`UPDATE ordering_modifier_options SET price_delta_cents=175,updated_at=NOW() WHERE group_id=${LARGE_DRESSING}`;
    await sql`UPDATE ordering_modifier_options SET name='Crumbly Blue Cheese',price_delta_cents=75,updated_at=NOW() WHERE group_id=${SMALL}`;
    await sql`UPDATE ordering_modifier_options SET name='Crumbly Blue Cheese',price_delta_cents=175,updated_at=NOW() WHERE group_id=${LARGE}`;
    const small=(await sql`SELECT id FROM ordering_modifier_options WHERE group_id=${SALAD} AND name='SM Tossed Sal'`)[0].id;
    const large=(await sql`SELECT id FROM ordering_modifier_options WHERE group_id=${SALAD} AND name IN ('LG Tossed Sal','Roni Tossed Sal')`).map(row=>row.id);
    const items=await sql`SELECT item_id FROM ordering_menu_item_modifier_groups WHERE group_id=${SALAD}`;
    for(const row of items){
      await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(gen_random_uuid(),${row.item_id},${SMALL},22),(gen_random_uuid(),${row.item_id},${LARGE},23) ON CONFLICT(item_id,group_id) DO NOTHING`;
      await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,parent_group_id,parent_option_ids,presentation_style,updated_by) VALUES(${row.item_id},${SMALL},'dependent',${SALAD},${[small]},'staged','crumbly-blue-dressings'),(${row.item_id},${LARGE},'dependent',${SALAD},${large},'staged','crumbly-blue-dressings') ON CONFLICT(item_id,group_id) DO UPDATE SET context='dependent',parent_group_id=EXCLUDED.parent_group_id,parent_option_ids=EXCLUDED.parent_option_ids,presentation_style='staged',updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      sideMeals+=1;
    }
  });
  console.log(JSON.stringify({sideMeals,smallPriceCents:75,largePriceCents:175,multipleQuantities:true,neverIncludedFree:true},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
