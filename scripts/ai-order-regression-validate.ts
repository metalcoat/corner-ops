#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

async function main(){
  const [{ensureOrderingAiSchema},{getSql},{priceSpokenOrder},{recordAiRegression}]=await Promise.all([import("../src/lib/ordering-ai-schema"),import("../src/lib/db"),import("../src/lib/ordering-ai-tools"),import("../src/lib/ordering-ai-regressions")]);
  await ensureOrderingAiSchema();const sql=getSql(),actor={id:"regression",name:"Regression Harness",type:"employee" as const,role:"employee" as const};
  const fixtures=[
    {key:"jumbo-half-pizza",items:[{name:"piza",variant:"large",quantity:1,modifiers:[{name:"pepporoni"},{name:"onions",portion:"left_half" as const},{name:"sausage",portion:"right_half" as const}]}],expectedItems:["Pizza"]},
    {key:"wings-and-fries",items:[{name:"wing",variant:"20 wing",quantity:1,modifiers:[{name:"mild"}]},{name:"large fry",quantity:1,modifiers:[{name:"nacho chesse"}]}],expectedItems:["Wings","Large French Fries"],expectedModifier:"Nacho Cheese on Side"},
  ];
  for(const fixture of fixtures){await recordAiRegression({business:"Corner Deli",caseType:"order_resolution",source:"permanent_fixture",payload:{serviceType:"pickup",items:fixture.items},expected:{items:fixture.expectedItems,modifier:fixture.expectedModifier||null}})}
  const stored=await sql`SELECT case_key,input,expected,source FROM ordering_ai_regression_cases WHERE business='Corner Deli' AND active=TRUE AND case_type='order_resolution' ORDER BY first_seen_at`;
  let passed=0;for(const row of stored){const payload=row.input as {serviceType?:string;items?:any[]};if(!Array.isArray(payload.items)||!payload.items.length)continue;let priced:Record<string,any>|undefined;try{priced=await priceSpokenOrder({business:"Corner Deli",actor,service:"pickup",items:payload.items});const names=priced.lines.map((line:Record<string,any>)=>line.item_name_snapshot);for(const expected of (row.expected?.items||[]))assert.ok(names.includes(expected),`${row.source}: missing ${expected}`);if(row.expected?.modifier){const modifiers=await sql`SELECT option_name_snapshot FROM ordering_order_item_modifiers WHERE order_item_id IN(SELECT id FROM ordering_order_items WHERE order_id=${priced.id})`;assert.ok(modifiers.some((modifier:Record<string,any>)=>modifier.option_name_snapshot===row.expected.modifier),`${row.source}: missing ${row.expected.modifier}`)}passed++}finally{if(priced?.id)await sql`DELETE FROM ordering_orders WHERE id=${priced.id}`}}
  console.log(JSON.stringify({storedCases:stored.length,executed:passed,status:"passed"},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
