#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
import { orderingBusinessConfig } from "../src/lib/ordering-business-config";

localValidationEnv();
const ROLLBACK="rollback:tiki-pos-validation";
async function main(){
  const tiki=orderingBusinessConfig("Tiki"),deli=orderingBusinessConfig("Corner Deli");
  assert.deepEqual(tiki.serviceTypes,["bar","pickup","dine_in"]);assert(tiki.features.barTabs&&!tiki.features.delivery&&!tiki.features.drivers);assert(tiki.utilities.includes("bar_tabs")&&!tiki.utilities.includes("drivers"));assert(deli.utilities.includes("drivers"));
  const {getSql,withTransaction}=await import("../src/lib/db");
  const {ensureOrderingPosSchema}=await import("../src/lib/ordering-pos-schema");
  const {appendTikiTabItems,listOpenTikiTabs,TabConflictError}=await import("../src/lib/ordering-tabs");
  await ensureOrderingPosSchema();const result:Record<string,unknown>={};
  try{await withTransaction(async()=>{const sql=getSql(),categoryId=randomUUID(),tikiItemId=randomUUID(),deliItemId=randomUUID(),tabId=randomUUID(),deliOrderId=randomUUID();
    await sql`INSERT INTO ordering_menu_categories(id,business,name,display_name,active) VALUES(${categoryId},'Tiki',${`Tiki fixture ${categoryId}`},'Tiki Fixture',TRUE)`;
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents,active,available) VALUES(${tikiItemId},'Tiki',${categoryId},'Tiki Fixture Drink',725,TRUE,TRUE)`;
    const deliCategory=(await sql`SELECT id FROM ordering_menu_categories WHERE business='Corner Deli' LIMIT 1`)[0];
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents,active,available) VALUES(${deliItemId},'Corner Deli',${deliCategory.id},${`Deli scope fixture ${deliItemId}`},999,TRUE,TRUE)`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot) VALUES(${tabId},'Tiki','pos','draft','unpaid','bar',${`TIKI-${tabId.slice(0,8)}`},'tiki-validator','Guest Tab')`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by) VALUES(${deliOrderId},'Corner Deli','pos','draft','unpaid','pickup',${`DELI-${deliOrderId.slice(0,8)}`},'tiki-validator')`;
    const actor={id:"tiki-validator",name:"Tiki Validator",type:"employee" as const,role:"manager" as const};
    const updated=await appendTikiTabItems({orderId:tabId,items:[{itemId:tikiItemId,quantity:2}],actor});assert.equal(Number(updated?.total_cents),1450);
    const tabs=await listOpenTikiTabs();assert(tabs.some(row=>row.id===tabId&&Number(row.item_count)===2));
    const variantId=randomUUID(),groupId=randomUUID(),optionId=randomUUID();
    await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents) VALUES(${variantId},${tikiItemId},'Large fixture',1200)`;
    await sql`INSERT INTO ordering_modifier_groups(id,business,name,max_selections,allow_option_quantity) VALUES(${groupId},'Tiki',${`Included fixture ${groupId}`},1,TRUE)`;
    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents) VALUES(${optionId},${groupId},'Fixture extra',100)`;
    await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id) VALUES(${randomUUID()},${tikiItemId},${groupId})`;
    await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,included_choice_count) VALUES(${tikiItemId},${groupId},1)`;
    await sql`INSERT INTO ordering_menu_variant_modifier_prices(id,variant_id,option_id,price_delta_cents) VALUES(${randomUUID()},${variantId},${optionId},175)`;
    const priced=await appendTikiTabItems({orderId:tabId,items:[{itemId:tikiItemId,variantId,quantity:2,modifierSelections:{[groupId]:[optionId]},modifierQuantities:{[optionId]:3}}],actor});
    assert.equal(Number(priced?.total_cents),1450+2*(1200+2*175));
    result.variantAllowanceQuantityPricing=true;
    let crossMenu=false;try{await appendTikiTabItems({orderId:tabId,items:[{itemId:deliItemId}],actor})}catch(error){crossMenu=error instanceof Error&&/this business/.test(error.message)}assert(crossMenu);
    let crossOrder=false;try{await appendTikiTabItems({orderId:deliOrderId,items:[{itemId:tikiItemId}],actor})}catch(error){crossOrder=error instanceof TabConflictError}assert(crossOrder);
    await sql`UPDATE ordering_orders SET paid_cents=total_cents,amount_due_cents=0,payment_status='paid' WHERE id=${tabId}`;
    let closed=false;try{await appendTikiTabItems({orderId:tabId,items:[{itemId:tikiItemId}],actor})}catch(error){closed=error instanceof TabConflictError}assert(closed);
    Object.assign(result,{separateMenu:true,openTab:true,addItemsLater:true,integerCents:true,crossBusinessMenuBlocked:true,crossBusinessOrderBlocked:true,closedTabImmutable:true,noDrivers:true});throw new Error(ROLLBACK);
  })}catch(error){if(!(error instanceof Error)||error.message!==ROLLBACK)throw error}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.stack||error.message:String(error));process.exitCode=1});
