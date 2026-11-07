#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(){
  const {getSql}=await import("../src/lib/db");
  const {ensureOrderingMenuOverrideSchema}=await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  const sql=getSql(),items=await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND active=TRUE AND base_price_cents=550 AND name ILIKE '3 Piece%Raspberry%Cheese%Log%'`;
  for(const item of items){
    await sql`INSERT INTO ordering_item_overrides(item_id,visible,updated_by) VALUES(${item.id},FALSE,'cheesecake-log-cleanup') ON CONFLICT(item_id) DO UPDATE SET visible=FALSE,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
    await sql`INSERT INTO ordering_item_channel_overrides(item_id,channel,visible,updated_by) VALUES(${item.id},'pos',FALSE,'cheesecake-log-cleanup'),(${item.id},'web',FALSE,'cheesecake-log-cleanup') ON CONFLICT(item_id,channel) DO UPDATE SET visible=FALSE,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
  }
  console.log(JSON.stringify({hiddenCheaperThreePieceItems:items.length,keptPriceCents:600},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
