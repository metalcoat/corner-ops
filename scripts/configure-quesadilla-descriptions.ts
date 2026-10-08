#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(){
  const {getSql}=await import("../src/lib/db");
  const {ensureOrderingMenuOverrideSchema}=await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  const sql=getSql(),items=await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND active=TRUE AND name ILIKE '%Quesadilla%'`;
  for(const item of items)await sql`INSERT INTO ordering_item_overrides(item_id,description,updated_by) VALUES(${item.id},'Comes with salsa and cheese.','quesadilla-descriptions') ON CONFLICT(item_id) DO UPDATE SET description=EXCLUDED.description,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
  console.log(JSON.stringify({quesadillasUpdated:items.length,description:"Comes with salsa and cheese."},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
