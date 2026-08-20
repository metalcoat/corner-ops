#!/usr/bin/env node
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {loadEnvFile} from "node:process";
loadEnvFile("/opt/corner-ops/.env");
const host=execFileSync("docker",["inspect","corner-ops-postgres","--format","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],{encoding:"utf8"}).trim();
if(!process.env.POSTGRES_PASSWORD)throw new Error("POSTGRES_PASSWORD is required.");
process.env.DATABASE_DRIVER="postgres";
process.env.DATABASE_URL=`postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${host}:5432/cornerops`;
async function main(){
  const {getSql}=await import("../src/lib/db"),{ensureDriverDeliverySchema}=await import("../src/lib/ordering-driver-delivery"),{orderingStoreDashboard}=await import("../src/lib/ordering-store-dashboard");
  await ensureDriverDeliverySchema();
  const sql=getSql(),orderId=randomUUID(),display=`DASH${Date.now()}`;
  try{
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,timing_mode,scheduled_for,display_number,first_name_snapshot,last_name_snapshot,phone_snapshot,created_by,total_cents,amount_due_cents)VALUES(${orderId},'Corner Deli','pos','ready','unpaid','delivery','future',NOW()+INTERVAL '1 hour',${display},'Timed','Customer','3155551212','validation',2500,2500)`;
    await sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at)VALUES(${orderId},'100 Main St','100 Main St, Syracuse, NY 13202','100 Main St','Syracuse','NY','13202',43.0481,-76.1474,'fixture','validated',NOW())`;
    const dashboard=await orderingStoreDashboard(),delivery=dashboard.deliveries.find(row=>row.display_number===display);
    const unpaidOrder=dashboard.unpaidOrders.some(row=>row.display_number===display);
    console.log(JSON.stringify({timedOrder:dashboard.timedOrders.some(row=>row.display_number===display),unpaidOrder,deliveryCreated:Boolean(delivery),unassignedTask:dashboard.tasks.find(task=>task.key==="unassigned")!.count>0,unpaidTask:dashboard.tasks.find(task=>task.key==="unpaid")!.count>0},null,2));
    if(!delivery||!unpaidOrder||!dashboard.timedOrders.some(row=>row.display_number===display))throw new Error("Store dashboard did not surface the timed, unpaid delivery fixture.");
  }finally{await sql`DELETE FROM ordering_orders WHERE id=${orderId}`}
}
main().catch(error=>{console.error(error);process.exitCode=1});
