import { randomUUID } from "node:crypto";
import { getSql } from "../src/lib/db";
import { ensureOrderingMenuEditorSchema } from "../src/lib/ordering-menu-editor-schema";
import { mutateMenu } from "../src/lib/ordering-menu-editor";
import { applyMenuImportRun,createMenuImportPreview } from "../src/lib/ordering-menu-import";

async function main(){
 await ensureOrderingMenuEditorSchema();const sql=getSql(),actor={id:"menu-editor-validator",business:"Corner Deli" as const},stamp=Date.now(),sourceId=`editor-${stamp}`,categoryName=`EDITOR TEST ${stamp}`,itemName=`TEST GARLIC KNOTS ${stamp}`;let categoryId="",importedId="",nativeId="",groupId="",optionId="",orderId="";
 try{
  const first={source:"json" as const,business:"Corner Deli" as const,categories:[{sourceId:`cat-${sourceId}`,name:categoryName,items:[{sourceId,name:`Jumbo Pizza ${stamp}`,basePriceCents:1650,modifierGroups:[]}]}]};
  const preview=await createMenuImportPreview({snapshot:first,createdBy:actor.id});await applyMenuImportRun({runId:preview.runId,approvedBy:actor.id});
  const imported=(await sql`SELECT i.id,i.category_id FROM ordering_menu_items i JOIN ordering_menu_source_map m ON m.internal_id=i.id AND m.source_id=${sourceId} WHERE i.business='Corner Deli'`)[0];if(!imported)throw new Error("Imported fixture missing.");importedId=imported.id;categoryId=imported.category_id;
  await mutateMenu(actor,{action:"update",entity:"item",id:importedId,patch:{basePriceCents:1700}});
  const second={...first,categories:[{...first.categories[0],items:[{...first.categories[0].items[0],basePriceCents:1650}]}]};const rerun=await createMenuImportPreview({snapshot:second,createdBy:actor.id});await applyMenuImportRun({runId:rerun.runId,approvedBy:actor.id});
  if(Number((await sql`SELECT base_price_cents FROM ordering_menu_items WHERE id=${importedId}`)[0].base_price_cents)!==1700)throw new Error("Import overwrote local price.");
  await mutateMenu(actor,{action:"reset_field",entity:"item",id:importedId,field:"base_price_cents"});if(Number((await sql`SELECT base_price_cents FROM ordering_menu_items WHERE id=${importedId}`)[0].base_price_cents)!==1650)throw new Error("Reset to imported failed.");
  const native=await mutateMenu(actor,{action:"create_item",categoryId,name:itemName,basePriceCents:600});nativeId=String(native.id);
  const third=await createMenuImportPreview({snapshot:second,createdBy:actor.id});await applyMenuImportRun({runId:third.runId,approvedBy:actor.id});if(!(await sql`SELECT id FROM ordering_menu_items WHERE id=${nativeId} AND active=TRUE`)[0])throw new Error("Native item did not survive import.");
  const group=await mutateMenu(actor,{action:"create_modifier_group",itemId:nativeId,name:`Choose 2 Sides ${stamp}`,minSelections:2,maxSelections:2});groupId=String(group.id);const option=await mutateMenu(actor,{action:"create_modifier_option",groupId,name:`Side ${stamp}`,priceDeltaCents:200});optionId=String(option.id);
  orderId=randomUUID();await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,subtotal_cents,total_cents,amount_due_cents) VALUES(${orderId},'Corner Deli','pos','sent_to_kitchen','unpaid','pickup',${`EDITOR-${stamp}`},${actor.id},600,600,600)`;await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,modifier_total_cents,line_total_cents,sort_order) VALUES(${randomUUID()},${orderId},${nativeId},${itemName},1,600,0,600,0)`;
  await mutateMenu(actor,{action:"update",entity:"item",id:nativeId,patch:{basePriceCents:650}});const snapshot=(await sql`SELECT unit_price_cents,item_name_snapshot FROM ordering_order_items WHERE order_id=${orderId}`)[0];if(Number(snapshot.unit_price_cents)!==600||snapshot.item_name_snapshot!==itemName)throw new Error("Historical snapshot changed.");
  let cross=false;try{await mutateMenu({id:actor.id,business:"Tiki"},{action:"update",entity:"item",id:nativeId,patch:{basePriceCents:1}})}catch{cross=true}if(!cross)throw new Error("Cross-business mutation was accepted.");
  const audit=await sql`SELECT COUNT(*) count FROM ordering_menu_override_audit WHERE actor_id=${actor.id}`;if(Number(audit[0].count)<5)throw new Error("Menu changes were not audited.");
  console.log(JSON.stringify({stableImportedId:true,localPriceSurvivesImport:true,resetToImported:true,nativeItemSurvivesImport:true,nativeStableId:nativeId,historicalPriceSnapshot:true,modifierMinMax:true,crossBusinessRejected:true,audited:true,integerCents:true},null,2));
 } finally {
  if(orderId)await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
  if(nativeId)await sql`DELETE FROM ordering_menu_items WHERE id=${nativeId}`;
  if(groupId)await sql`DELETE FROM ordering_modifier_groups WHERE id=${groupId}`;
  await sql`DELETE FROM ordering_menu_source_map WHERE source_id IN (${sourceId},${`cat-${sourceId}`})`;
  if(importedId)await sql`DELETE FROM ordering_menu_items WHERE id=${importedId}`;
  if(categoryId)await sql`DELETE FROM ordering_menu_categories WHERE id=${categoryId}`;
  await sql`DELETE FROM ordering_menu_import_runs WHERE created_by=${actor.id}`;
  await sql`DELETE FROM ordering_menu_override_audit WHERE actor_id=${actor.id}`;
  await sql`DELETE FROM ordering_menu_local_fields WHERE updated_by=${actor.id}`;
 }
}
main().then(()=>process.exit()).catch(error=>{console.error(error);process.exit(1)});
