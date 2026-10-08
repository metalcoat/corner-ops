#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const ITEM="2ba6b94c-45e9-4b44-b1ab-d564281d74e4",COLESLAW="271b1148-e6ca-4f07-9f54-8c6af156b7f0",SOURCE="7f0d1432-c2db-48ef-9b3a-8ef65b39652a",INCLUDED="c7100000-0000-4000-8000-000000000001",EXTRAS="c7100000-0000-4000-8000-000000000002";

async function main(){
  const {getSql,withTransaction}=await import("../src/lib/db");
  const {ensureOrderingMenuOverrideSchema}=await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  await withTransaction(async()=>{
    const sql=getSql();
    await sql`INSERT INTO ordering_modifier_groups(id,business,name,prompt,min_selections,max_selections,allow_option_quantity,active) VALUES(${INCLUDED},'Corner Deli','Included Dipping Sauce','Choose one included 4oz dipping sauce',1,1,FALSE,TRUE),(${EXTRAS},'Corner Deli','Add Extra Dipping Sauces','Additional 4oz sauces are $1.75 each',0,8,TRUE,TRUE) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,prompt=EXCLUDED.prompt,min_selections=EXCLUDED.min_selections,max_selections=EXCLUDED.max_selections,allow_option_quantity=EXCLUDED.allow_option_quantity,active=TRUE,updated_at=NOW()`;
    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${INCLUDED},name,0,available,active,sort_order FROM ordering_modifier_options WHERE group_id=${SOURCE} ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=0,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;
    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${EXTRAS},name,CASE WHEN name='No Sauce' THEN 0 ELSE 175 END,available,active,sort_order FROM ordering_modifier_options WHERE group_id=${SOURCE} ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=EXCLUDED.price_delta_cents,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;
    await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,included_choice_count,presentation_style,component_order,updated_by) VALUES(${ITEM},${SOURCE},'hidden',0,'staged',10,'chicken-dinner-includes'),(${ITEM},${COLESLAW},'ordinary',1,'staged',10,'chicken-dinner-includes'),(${ITEM},${INCLUDED},'ordinary',0,'staged',20,'chicken-dinner-includes'),(${ITEM},${EXTRAS},'ordinary',0,'staged',21,'chicken-dinner-includes') ON CONFLICT(item_id,group_id) DO UPDATE SET context=EXCLUDED.context,included_choice_count=EXCLUDED.included_choice_count,presentation_style=EXCLUDED.presentation_style,component_order=EXCLUDED.component_order,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
    await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(gen_random_uuid(),${ITEM},${INCLUDED},20),(gen_random_uuid(),${ITEM},${EXTRAS},21) ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`;
  });
  console.log(JSON.stringify({includedColeslaw:true,noSlawDeclinesIncluded:true,includedSauces:1,extraSauceCents:175},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
