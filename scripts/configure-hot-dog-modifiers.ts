#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const ITEMS=[
  "665d3e4f-fe66-411a-834d-24f685e7b3eb", // Hot Dog
  "850a8b9c-e742-41e5-ae2f-f2a64c50fb96", // Kids Hot Dog w/ SM Fry
];
const SOURCE="d4f85624-1228-4c7d-90cd-ba025b51dbea",HOT_DOG="d0900000-0000-4000-8000-000000000001";

async function main(){
  const {getSql,withTransaction}=await import("../src/lib/db");
  const {ensureOrderingMenuOverrideSchema}=await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  await withTransaction(async()=>{
    const sql=getSql();
    await sql`INSERT INTO ordering_modifier_groups(id,business,name,prompt,min_selections,max_selections,allow_option_quantity,active) SELECT ${HOT_DOG},business,'Hot Dog Choices','Choose hot dog toppings',min_selections,max_selections,allow_option_quantity,TRUE FROM ordering_modifier_groups WHERE id=${SOURCE} ON CONFLICT(id) DO UPDATE SET name='Hot Dog Choices',prompt='Choose hot dog toppings',active=TRUE,updated_at=NOW()`;
    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${HOT_DOG},name,price_delta_cents,available,active,sort_order FROM ordering_modifier_options WHERE group_id=${SOURCE} AND name<>'Fresh Patty (6oz)' ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=EXCLUDED.price_delta_cents,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;
    for(const item of ITEMS){
      await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(gen_random_uuid(),${item},${HOT_DOG},1) ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=1`;
      await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,presentation_style,updated_by) VALUES(${item},${SOURCE},'hidden','grid','hot-dog-modifiers'),(${item},${HOT_DOG},'ordinary','grid','hot-dog-modifiers') ON CONFLICT(item_id,group_id) DO UPDATE SET context=EXCLUDED.context,presentation_style=EXCLUDED.presentation_style,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
    }
  });
  console.log(JSON.stringify({items:["Hot Dog","Hot Dog w/ SM Fry"],group:"Hot Dog Choices",burgerGroupHidden:true,freshPattyRemoved:true},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
