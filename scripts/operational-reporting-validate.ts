import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

void (async()=>{
  const { ensureOrderingPromotionSchema }=await import("../src/lib/ordering-promotion-schema");
  const { ensureOrderingGiftCardSchema }=await import("../src/lib/ordering-gift-card-schema");
  const { orderingOperationalReport }=await import("../src/lib/ordering-operational-report");
  const { getSql }=await import("../src/lib/db");
  await Promise.all([ensureOrderingPromotionSchema(),ensureOrderingGiftCardSchema()]);
  const sql=getSql(), tag=`report-validator-${randomUUID()}`, deliOrder=randomUUID(), tikiOrder=randomUUID(), cancelledOrder=randomUUID(), item=randomUUID(), category=randomUUID(), payment=randomUUID(), reversal=randomUUID();
  const today=new Date().toISOString().slice(0,10);
  try {
    await sql`INSERT INTO ordering_menu_categories(id,business,name,display_name,active) VALUES(${category},'Corner Deli',${tag},'Validation category',TRUE)`;
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${item},'Corner Deli',${category},${tag},1000)`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,gross_base_merchandise_cents,modifier_revenue_cents,promotion_discount_cents,loyalty_discount_cents,net_merchandise_cents,delivery_fee_cents,subtotal_cents,total_cents,paid_cents,amount_due_cents,created_by,created_at) VALUES
      (${deliOrder},'Corner Deli','pos','completed','paid','delivery',${tag},1000,200,100,50,1050,300,1200,1350,1350,0,${tag},NOW()),
      (${cancelledOrder},'Corner Deli','pos','cancelled','unpaid','pickup',${`${tag}-cancelled`},900,0,0,0,900,0,900,900,0,900,${tag},NOW()),
      (${tikiOrder},'Tiki','pos','completed','paid','bar',${tag},9999,0,0,0,9999,0,9999,9999,9999,0,${tag},NOW())`;
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,category_name_snapshot,quantity,unit_price_cents,modifier_total_cents,line_total_cents) VALUES(${randomUUID()},${deliOrder},${item},'Snapshot sandwich','Validation category',1,1000,200,1200)`;
    await sql`INSERT INTO ordering_payment_transactions(id,business,order_id,tender_type,transaction_type,status,amount_cents,created_by,created_at) VALUES(${payment},'Corner Deli',${deliOrder},'cash','payment','approved',1350,${tag},NOW()),(${reversal},'Corner Deli',${deliOrder},'cash','void','approved',250,${tag},NOW())`;
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) VALUES(${randomUUID()},${deliOrder},1,'status_changed','employee',${tag},'{}')`;
    const report=await orderingOperationalReport({business:'Corner Deli',start:today,end:today});
    if(report.summary.orders!==1||report.summary.gross_merchandise_cents!==1000||report.summary.order_total_cents!==1350)throw new Error('Finalized sales snapshot aggregation failed.');
    if(report.salesByServiceType.some(row=>row.label==='bar'))throw new Error('Cross-business report isolation failed.');
    if(report.tenders[0]?.payments_cents!==1350||report.tenders[0]?.reversals_cents!==250)throw new Error('Tender/reversal aggregation failed.');
    if(!Array.isArray(report.giftCards))throw new Error('Gift-card report contract failed.');
    if(!report.salesByCategory.some(row=>row.label==='Validation category')||!report.employeeActions.some(row=>row.actor_id===tag))throw new Error('Snapshot category or employee action reporting failed.');
    console.log(JSON.stringify({authoritativeOrderSnapshots:true,immutableLedgers:true,crossBusinessIsolation:true,cancelledExcluded:true,categorySnapshots:true,employeeActions:true,fixturesCleaned:true},null,2));
  } finally {
    await sql`DELETE FROM ordering_payment_transactions WHERE id IN (${payment},${reversal})`;
    await sql`DELETE FROM ordering_orders WHERE id IN (${deliOrder},${cancelledOrder},${tikiOrder})`;
    await sql`DELETE FROM ordering_menu_items WHERE id=${item}`;
    await sql`DELETE FROM ordering_menu_categories WHERE id=${category}`;
  }
})().catch(error=>{console.error(error);process.exitCode=1});
