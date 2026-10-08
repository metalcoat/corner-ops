#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(){
  const {getSql}=await import("../src/lib/db");
  const sql=getSql(),item=(await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND name='Clubhouse Sandwich' LIMIT 1`)[0],option=(await sql`SELECT option.id FROM ordering_modifier_options option JOIN ordering_modifier_groups grp ON grp.id=option.group_id WHERE grp.business='Corner Deli' AND grp.name='Clubhouse mods' AND option.name='Toasted' LIMIT 1`)[0];
  if(!item||!option)throw new Error("Clubhouse Sandwich or Toasted option was not found.");
  await sql`INSERT INTO ordering_menu_item_modifier_defaults(id,item_id,option_id,default_selected,included_quantity,active) VALUES(gen_random_uuid(),${item.id},${option.id},TRUE,1,TRUE) ON CONFLICT(item_id,option_id) DO UPDATE SET default_selected=TRUE,included_quantity=1,active=TRUE,updated_at=NOW()`;
  console.log(JSON.stringify({item:"Clubhouse Sandwich",default:"Toasted"},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
