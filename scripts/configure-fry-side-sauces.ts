#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(){
  const {getSql,withTransaction}=await import("../src/lib/db");
  let gravy=0,nacho=0;
  await withTransaction(async()=>{
    const sql=getSql();
    const gravyRows=await sql`UPDATE ordering_modifier_options option SET name='Gravy on Side',price_delta_cents=175,updated_at=NOW() FROM ordering_modifier_groups grp WHERE grp.id=option.group_id AND grp.business='Corner Deli' AND grp.active=TRUE AND grp.name ILIKE '%Fry Option%' AND option.active=TRUE AND option.name IN ('Gravy','Gravy on Side') RETURNING option.id`;
    const nachoRows=await sql`UPDATE ordering_modifier_options option SET name='Nacho Cheese on Side',price_delta_cents=175,updated_at=NOW() FROM ordering_modifier_groups grp WHERE grp.id=option.group_id AND grp.business='Corner Deli' AND grp.active=TRUE AND grp.name ILIKE '%Fry Option%' AND option.active=TRUE AND option.name IN ('Nacho Cheese','Nacho Cheese on Side') RETURNING option.id`;
    await sql`UPDATE ordering_modifier_options option SET name='Cajun Tossed',updated_at=NOW() FROM ordering_modifier_groups grp WHERE option.group_id=grp.id AND grp.business='Corner Deli' AND grp.name='Spicy or Plain' AND option.active=TRUE AND option.name IN ('Spicy','Cajun Tossed')`;
    gravy=gravyRows.length;nacho=nachoRows.length;
  });
  console.log(JSON.stringify({gravyOptionsUpdated:gravy,nachoOptionsUpdated:nacho,priceCents:175},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
