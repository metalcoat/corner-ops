#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const ITEM = "2b24f18e-a0c4-4796-b253-0f48a20e52c7";
const OLD_TWO_SIDE = "57113e6e-e3b2-42a6-8ad4-fd07413b5bcd";
const SALAD = "616994ef-6c0a-4f3f-b787-38abc7a481c9";
const SOURCE_DRESSING = "0454bee0-b63d-4c32-bbe8-908d9f94ae42";
const SOURCE_SIDE = "5fabc564-7c33-480b-96ef-28a018ca0e60";
const SOURCE_FRY = "59061047-6e99-4c58-a34e-7412214bf059";
const SOURCE_MASHED = "ccab5488-c060-46a8-bb82-e603a791b788";
const TARTAR = "8a4c0187-ae48-4e0c-8387-751c26cb5ce5";
const ON_TOP = "f1500000-0000-4000-8000-000000000001";
const FOUR_OZ = "f1500000-0000-4000-8000-000000000002";
const SIDE_ONE = "f1500000-0000-4000-8000-000000000003";
const SIDE_ONE_FRY = "f1500000-0000-4000-8000-000000000004";
const SIDE_ONE_MASHED = "f1500000-0000-4000-8000-000000000005";
const SIDE_TWO = "f1500000-0000-4000-8000-000000000006";
const SIDE_TWO_FRY = "f1500000-0000-4000-8000-000000000007";
const SIDE_TWO_MASHED = "f1500000-0000-4000-8000-000000000008";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingMenuOverrideSchema } = await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  await withTransaction(async () => {
    const sql = getSql();
    await sql`INSERT INTO ordering_item_overrides(item_id,display_name,visible,updated_by) VALUES(${ITEM},'Fish Fry Dinner',TRUE,'fish-fry-staged-flow') ON CONFLICT(item_id) DO UPDATE SET display_name='Fish Fry Dinner',visible=TRUE,updated_by='fish-fry-staged-flow',updated_at=NOW()`;
    await sql`INSERT INTO ordering_item_overrides(item_id,visible,updated_by) VALUES(${OLD_TWO_SIDE},FALSE,'fish-fry-staged-flow') ON CONFLICT(item_id) DO UPDATE SET visible=FALSE,updated_by='fish-fry-staged-flow',updated_at=NOW()`;
    await sql`INSERT INTO ordering_item_channel_overrides(item_id,channel,display_name,visible,updated_by) VALUES(${ITEM},'pos','Fish Fry Dinner',TRUE,'fish-fry-staged-flow'),(${ITEM},'web','Fish Fry Dinner',TRUE,'fish-fry-staged-flow') ON CONFLICT(item_id,channel) DO UPDATE SET display_name='Fish Fry Dinner',visible=TRUE,updated_by='fish-fry-staged-flow',updated_at=NOW()`;
    await sql`INSERT INTO ordering_item_channel_overrides(item_id,channel,visible,updated_by) VALUES(${OLD_TWO_SIDE},'pos',FALSE,'fish-fry-staged-flow'),(${OLD_TWO_SIDE},'web',FALSE,'fish-fry-staged-flow') ON CONFLICT(item_id,channel) DO UPDATE SET visible=FALSE,updated_by='fish-fry-staged-flow',updated_at=NOW()`;
    await sql`UPDATE ordering_menu_item_variants SET base_price_cents=1350 WHERE item_id=${ITEM}`;
    await sql`UPDATE ordering_menu_items SET base_price_cents=1350 WHERE id=${ITEM}`;

    const groups = [
      [ON_TOP,"Choose Dressing (On Salad)","Choose one dressing for the small tossed salad",1,1],
      [FOUR_OZ,"Choose 4oz Dressing","Choose one 4oz dressing",1,1],
      [SIDE_ONE,"Choose Included Side","Choose one included side",1,1],
      [SIDE_ONE_FRY,"First Side Fry Options","Customize the first fried side",0,10],
      [SIDE_ONE_MASHED,"First Side Mashed Options","Customize the first mashed side",0,3],
      [SIDE_TWO,"Add a Second Side (+$3.00)","Optional second side makes the dinner $16.50",0,1],
      [SIDE_TWO_FRY,"Second Side Fry Options","Customize the second fried side",0,10],
      [SIDE_TWO_MASHED,"Second Side Mashed Options","Customize the second mashed side",0,3],
    ] as const;
    for (const [id,name,prompt,min,max] of groups)
      await sql`INSERT INTO ordering_modifier_groups(id,business,name,prompt,min_selections,max_selections,active) VALUES(${id},'Corner Deli',${name},${prompt},${min},${max},TRUE) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,prompt=EXCLUDED.prompt,min_selections=EXCLUDED.min_selections,max_selections=EXCLUDED.max_selections,active=TRUE,updated_at=NOW()`;

    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${ON_TOP},regexp_replace(name,' \\(On Salad\\)$',''),0,available,active,sort_order FROM ordering_modifier_options WHERE group_id=${SOURCE_DRESSING} AND name NOT IN ('No Tomato','No Salad') ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=0,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;
    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${FOUR_OZ},name||' 4oz',0,available,active,sort_order FROM ordering_modifier_options WHERE group_id='a18f597f-41ba-458f-a9df-f2cb112d8235' ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=0,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;
    for (const target of [SIDE_ONE,SIDE_TWO]) {
      const surcharge=target===SIDE_TWO?300:0;
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${target},name,price_delta_cents+${surcharge},available,active,sort_order FROM ordering_modifier_options WHERE group_id=${SOURCE_SIDE} ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=EXCLUDED.price_delta_cents,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,sort_order) VALUES(gen_random_uuid(),${target},'Mac and Cheese',${surcharge},12) ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=EXCLUDED.price_delta_cents,active=TRUE,available=TRUE`;
    }
    for (const [target,source] of [[SIDE_ONE_FRY,SOURCE_FRY],[SIDE_TWO_FRY,SOURCE_FRY],[SIDE_ONE_MASHED,SOURCE_MASHED],[SIDE_TWO_MASHED,SOURCE_MASHED]] as const)
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) SELECT gen_random_uuid(),${target},name,price_delta_cents,available,active,sort_order FROM ordering_modifier_options WHERE group_id=${source} ON CONFLICT(group_id,name) DO UPDATE SET price_delta_cents=EXCLUDED.price_delta_cents,available=EXCLUDED.available,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order`;

    await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,updated_by) SELECT item_id,group_id,'hidden','fish-fry-staged-flow' FROM ordering_menu_item_modifier_groups WHERE item_id=${ITEM} ON CONFLICT(item_id,group_id) DO UPDATE SET context='hidden',updated_by='fish-fry-staged-flow',updated_at=NOW()`;
    for (const [groupId,order] of [[SALAD,10],[ON_TOP,20],[FOUR_OZ,21],[SIDE_ONE,30],[SIDE_ONE_FRY,40],[SIDE_ONE_MASHED,41],[SIDE_TWO,50],[SIDE_TWO_FRY,60],[SIDE_TWO_MASHED,61],[TARTAR,90]] as const) {
      await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(gen_random_uuid(),${ITEM},${groupId},${order}) ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`;
      await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,presentation_style,component_order,updated_by) VALUES(${ITEM},${groupId},'ordinary','staged',${order},'fish-fry-staged-flow') ON CONFLICT(item_id,group_id) DO UPDATE SET context='ordinary',presentation_style='staged',component_order=${order},updated_by='fish-fry-staged-flow',updated_at=NOW()`;
    }

    const small=(await sql`SELECT id FROM ordering_modifier_options WHERE group_id=${SALAD} AND name='SM Tossed Sal'`)[0].id;
    const largeSalads=(await sql`SELECT id FROM ordering_modifier_options WHERE group_id=${SALAD} AND name IN ('LG Tossed Sal','Roni Tossed Sal')`).map(row=>row.id);
    const sideDependency = async (child:string,parent:string,matcher:RegExp) => {
      const ids=(await sql`SELECT id,name FROM ordering_modifier_options WHERE group_id=${parent}`).filter(row=>matcher.test(String(row.name))).map(row=>row.id);
      await sql`UPDATE ordering_modifier_presentation_overrides SET context='dependent',parent_group_id=${parent},parent_option_ids=${ids},updated_at=NOW() WHERE item_id=${ITEM} AND group_id=${child}`;
    };
    await sql`UPDATE ordering_modifier_presentation_overrides SET context='dependent',parent_group_id=${SALAD},parent_option_ids=${[small]},updated_at=NOW() WHERE item_id=${ITEM} AND group_id=${ON_TOP}`;
    await sql`UPDATE ordering_modifier_presentation_overrides SET context='dependent',parent_group_id=${SALAD},parent_option_ids=${largeSalads},updated_at=NOW() WHERE item_id=${ITEM} AND group_id=${FOUR_OZ}`;
    const fried=/French Fries|Waffle Fries|Curly Fries|Tater Tots|Onion Rings/i,mashed=/Mashed/i;
    await sideDependency(SIDE_ONE_FRY,SIDE_ONE,fried); await sideDependency(SIDE_ONE_MASHED,SIDE_ONE,mashed);
    await sideDependency(SIDE_TWO_FRY,SIDE_TWO,fried); await sideDependency(SIDE_TWO_MASHED,SIDE_TWO,mashed);
  });
  console.log(JSON.stringify({configured:true,item:"Fish Fry Dinner",basePriceCents:1350,optionalSecondSideCents:300},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
