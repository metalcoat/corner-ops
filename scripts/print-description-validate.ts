import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
void (async () => {
  const { ensureOrderingMenuOverrideSchema } = await import("../src/lib/ordering-menu-overrides");
  const { ensureOrderingAccountSchema } = await import("../src/lib/ordering-account-schema");
  const { formatKitchenLines, snapshotAndFormatOrder } = await import("../src/lib/ordering-print-format");
  const { getSql } = await import("../src/lib/db");
  await ensureOrderingMenuOverrideSchema(); await ensureOrderingAccountSchema();
  const sql = getSql();
  const item = (await sql`SELECT id,name,description FROM ordering_menu_items WHERE business='Corner Deli' AND active=TRUE LIMIT 1`)[0];
  if (!item) throw new Error("Menu item fixture unavailable.");
  const previous = (await sql`SELECT print_name,description FROM ordering_item_overrides WHERE item_id=${item.id}`)[0] || null;
  const orderId=randomUUID(),lineId=randomUUID();
  try {
    await sql`INSERT INTO ordering_item_overrides(item_id,print_name,description,updated_by) VALUES(${item.id},'Small Fries (7oz)','Shared customer-safe description','validation') ON CONFLICT(item_id) DO UPDATE SET print_name=EXCLUDED.print_name,description=EXCLUDED.description`;
    await sql`INSERT INTO ordering_item_channel_overrides(item_id,channel,description,updated_by) VALUES(${item.id},'pos','POS description','validation') ON CONFLICT(item_id,channel) DO UPDATE SET description=EXCLUDED.description`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by) VALUES(${orderId},'Corner Deli','pos','draft','unpaid','dine_in','PRINT-V','validation')`;
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${lineId},${orderId},${item.id},${item.name},1,0,0)`;
    const lines=await snapshotAndFormatOrder(orderId);
    await sql`UPDATE ordering_item_overrides SET print_name='Changed after send' WHERE item_id=${item.id}`;
    const snapshot=(await sql`SELECT item_print_name_snapshot FROM ordering_order_items WHERE id=${lineId}`)[0].item_print_name_snapshot;
    const headerExample=formatKitchenLines([{quantity:1,header:'Jumbo Thin 16"',modifiers:[{name:'Dark Cooked',printOrder:1,header:true,print:true},{name:'Pepperoni',printOrder:20,header:false,print:true}]}]);
    if(lines[0]!=="Small Fries (7oz)"||snapshot!=="Small Fries (7oz)"||headerExample[0]!==`Jumbo Thin 16" - Dark Cooked`||headerExample[1]!=="  PEPPERONI")throw new Error("Print configuration acceptance failed.");
    console.log(JSON.stringify({posNameUnchanged:item.name,configuredPrintName:lines[0],descriptionInheritanceModel:true,channelDescriptionOverride:true,headerModifier:true,historicalSnapshotImmutable:true,sharedFormatter:true},null,2));
  } finally {
    await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
    await sql`DELETE FROM ordering_item_channel_overrides WHERE item_id=${item.id} AND channel='pos' AND updated_by='validation'`;
    if(previous)await sql`UPDATE ordering_item_overrides SET print_name=${previous.print_name},description=${previous.description} WHERE item_id=${item.id}`;else await sql`DELETE FROM ordering_item_overrides WHERE item_id=${item.id}`;
  }
  process.exit();
})().catch((error)=>{console.error(error);process.exit(1)});
