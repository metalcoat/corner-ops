#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

async function main(){
  const [{ensureOrderingAiSchema},{getSql},tools,{recordAiRegression}]=await Promise.all([import("../src/lib/ordering-ai-schema"),import("../src/lib/db"),import("../src/lib/ordering-ai-tools"),import("../src/lib/ordering-ai-regressions")]);
  const{priceSpokenOrder,createAiDraft,menuCatalog,AiToolError}=tools;
  await ensureOrderingAiSchema();const sql=getSql(),actor={id:"regression",name:"Regression Harness",type:"employee" as const,role:"employee" as const};
  const fixtures=[
    {key:"jumbo-half-pizza",items:[{name:"Pizza",variant:"large",quantity:1,modifiers:[{name:"Pepperoni"},{name:"Onions",portion:"left_half" as const},{name:"Sausage",portion:"right_half" as const}]}],expectedItems:["Pizza"]},
    {key:"wings-and-fries",items:[{name:"wing",variant:"20 wing",quantity:1,modifiers:[{name:"Mild"}]},{name:"large fry",quantity:1,modifiers:[{name:"nacho cheese"}]}],expectedItems:["Wings","Large French Fries"],expectedModifier:"Nacho Cheese on Side"},
    {key:"lobster-roll",items:[{name:"lobster roll",quantity:1}],errorCode:"ITEM_NOT_ON_MENU"},
    {key:"similar-item",items:[{name:"french fry sandwich",quantity:1}],errorCode:"ITEM_NOT_ON_MENU"},
    {key:"ambiguous-fries",items:[{name:"fries",quantity:1}],errorCode:"INVALID_VARIANT"},
    {key:"invalid-avocado",items:[{name:"Cheeseburger (1/4lbs)",quantity:1,modifiers:[{name:"avocado"}]}],errorCode:"INVALID_MODIFIER"},
    {key:"legacy-misspelled-pizza",items:[{name:"piza",variant:"large",quantity:1,modifiers:[{name:"pepporoni"},{name:"onions",portion:"left_half" as const},{name:"sausage",portion:"right_half" as const}]}],errorCode:"ITEM_NOT_ON_MENU"},
    {key:"legacy-misspelled-nacho",items:[{name:"wing",variant:"20 wing",quantity:1,modifiers:[{name:"mild"}]},{name:"large fry",quantity:1,modifiers:[{name:"nacho chesse"}]}],errorCode:"INVALID_MODIFIER"},
    {key:"spoken-jumbo-pizza",items:[{name:"jumbo 16 inch pizza",quantity:1,modifiers:[{name:"Pepperoni",portion:"left_half" as const},{name:"Onions",portion:"right_half" as const}]}],expectedItems:["Pizza"],expectedVariant:"Jumbo Thin 16\""},
    {key:"large-pizza-alias",items:[{name:"large pizza",quantity:1}],expectedItems:["Pizza"],expectedVariant:"Jumbo Thin 16\""},
    {key:"sixteen-inch-pizza-alias",items:[{name:'16" pizza',quantity:1}],expectedItems:["Pizza"],expectedVariant:"Jumbo Thin 16\""},
    {key:"standalone-jumbo-alias",items:[{name:"jumbo",quantity:1}],expectedItems:["Pizza"],expectedVariant:"Jumbo Thin 16\""},
    {key:"full-jumbo-thin-variant",items:[{name:"Pizza",variant:"jumbo thin 16 inch",quantity:1}],expectedItems:["Pizza"],expectedVariant:"Jumbo Thin 16\""},
    {key:"full-regular-variant",items:[{name:"Pizza",variant:"regular 14 inch",quantity:1}],expectedItems:["Pizza"],expectedVariant:"Regular 14\""},
    {key:"full-small-variant",items:[{name:"Pizza",variant:"small 12 inch",quantity:1}],expectedItems:["Pizza"],expectedVariant:"Small 12\""},
  ];
  for(const fixture of fixtures){await recordAiRegression({business:"Corner Deli",caseType:"order_resolution",source:"permanent_fixture",payload:{serviceType:"pickup",items:fixture.items},expected:{items:fixture.expectedItems||[],variant:fixture.expectedVariant||null,modifier:fixture.expectedModifier||null,errorCode:fixture.errorCode||null}})}
  const stored=await sql`SELECT case_key,input,expected,source FROM ordering_ai_regression_cases WHERE business='Corner Deli' AND active=TRUE AND case_type='order_resolution' ORDER BY first_seen_at`;
  let passed=0;for(const row of stored){const payload=row.input as {serviceType?:string;items?:any[]};if(!Array.isArray(payload.items)||!payload.items.length)continue;let priced:Record<string,any>|undefined;try{priced=await priceSpokenOrder({business:"Corner Deli",actor,service:"pickup",items:payload.items});assert.ok(!row.expected?.errorCode,`${row.source}: expected ${row.expected.errorCode} but order was created`);const names=priced.lines.map((line:Record<string,any>)=>line.item_name_snapshot);for(const expected of (row.expected?.items||[]))assert.ok(names.includes(expected),`${row.source}: missing ${expected}`);if(row.expected?.variant)assert.ok(priced.lines.some((line:Record<string,any>)=>line.variant_name_snapshot===row.expected.variant),`${row.source}: missing ${row.expected.variant}`);if(row.expected?.modifier){const modifiers=await sql`SELECT option_name_snapshot FROM ordering_order_item_modifiers WHERE order_item_id IN(SELECT id FROM ordering_order_items WHERE order_id=${priced.id})`;assert.ok(modifiers.some((modifier:Record<string,any>)=>modifier.option_name_snapshot===row.expected.modifier),`${row.source}: missing ${row.expected.modifier}`)}}catch(error){if(!row.expected?.errorCode)throw error;assert.ok(error instanceof AiToolError);assert.equal(error.code,row.expected.errorCode)}finally{if(priced?.id)await sql`DELETE FROM ordering_orders WHERE id=${priced.id}`}passed++}
  const before=Number((await sql`SELECT COUNT(*)::int count FROM ordering_orders`)[0].count),catalog=await menuCatalog("Corner Deli",new Date()),valid=catalog.flatMap((category:any)=>category.items).find((item:any)=>item.available);
  await assert.rejects(()=>createAiDraft({business:"Corner Deli",actor,service:"pickup",items:[{itemId:"00000000-0000-0000-0000-000000000000",quantity:1}]}),(error:any)=>error.code==="ITEM_NOT_ON_MENU");
  await assert.rejects(()=>createAiDraft({business:"Corner Deli",actor,service:"pickup",items:[{itemId:valid.id,variantId:valid.variants?.find((variant:any)=>variant.defaultVariant)?.id||valid.variants?.[0]?.id||null,quantity:1,specialInstructions:"ADD AVOCADO"}]}),(error:any)=>error.code==="INVALID_MODIFIER");
  assert.equal(Number((await sql`SELECT COUNT(*)::int count FROM ordering_orders`)[0].count),before,"Rejected IDs and notes must create no orders.");
  await assert.rejects(()=>priceSpokenOrder({business:"Corner Deli",actor,service:"undecided",items:[{name:"Pizza",variant:"large",quantity:1}]}),(error:any)=>error.code==="FULFILLMENT_REQUIRED");
  console.log(JSON.stringify({storedCases:stored.length,executed:passed,status:"passed"},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
