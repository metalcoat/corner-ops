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
  const sql=getSql(),orderId=randomUUID(),driverId=randomUUID(),trackingId=randomUUID(),display=`DASH${Date.now()}`;
  try{
    await sql`INSERT INTO employees(id,business,name,pin_hash,position,role_group,active)VALUES(${driverId},'Corner Deli',${`Dashboard Driver ${display}`},'','Driver','Driver',TRUE)`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,timing_mode,scheduled_for,display_number,first_name_snapshot,last_name_snapshot,phone_snapshot,created_by,total_cents,amount_due_cents)VALUES(${orderId},'Corner Deli','pos','ready','unpaid','delivery','future',NOW()+INTERVAL '1 hour',${display},'Timed','Customer','3155551212','validation',2500,2500)`;
    await sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at)VALUES(${orderId},'100 Main St','100 Main St, Syracuse, NY 13202','100 Main St','Syracuse','NY','13202',43.0481,-76.1474,'fixture','validated',NOW())`;
    await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,driver_employee_id,status,assigned_by)VALUES(${randomUUID()},${orderId},'Corner Deli',${driverId},'EN_ROUTE','validation')`;
    const assignment=(await sql`SELECT id FROM ordering_delivery_assignments WHERE order_id=${orderId}`)[0];
    await sql`INSERT INTO ordering_delivery_tracking_sessions(id,delivery_id,driver_id)VALUES(${trackingId},${assignment.id},${driverId})`;
    await sql`INSERT INTO ordering_delivery_locations(id,tracking_session_id,delivery_id,driver_id,client_event_id,captured_at,latitude,longitude,accuracy_meters)VALUES(${randomUUID()},${trackingId},${assignment.id},${driverId},${`dashboard-${display}`},NOW(),43.0481,-76.1474,9)`;
    const dashboard=await orderingStoreDashboard(),delivery=dashboard.deliveries.find(row=>row.display_number===display);
    const unpaidOrder=dashboard.unpaidOrders.some(row=>row.display_number===display);
    await sql`UPDATE ordering_delivery_tracking_sessions SET stopped_at=NOW(),stop_reason='DELIVERED' WHERE id=${trackingId}`;
    await sql`UPDATE ordering_delivery_assignments SET status='DELIVERED',delivered_at=NOW(),updated_at=NOW() WHERE id=${assignment.id}`;
    const completedDelivery=(await orderingStoreDashboard()).deliveries.find(row=>row.display_number===display);
    const liveGps=Number(delivery?.driver_latitude)===43.0481&&Number(delivery?.driver_longitude)===-76.1474&&Number(delivery?.driver_accuracy_meters)===9;
    const completedGpsHidden=completedDelivery?.driver_location_captured_at==null;
    console.log(JSON.stringify({timedOrder:dashboard.timedOrders.some(row=>row.display_number===display),unpaidOrder,deliveryCreated:Boolean(delivery),liveGps,completedGpsHidden,unpaidTask:dashboard.tasks.find(task=>task.key==="unpaid")!.count>0},null,2));
    if(!delivery||!unpaidOrder||!dashboard.timedOrders.some(row=>row.display_number===display)||!liveGps||!completedGpsHidden)throw new Error("Store dashboard did not correctly surface and retire the delivery GPS fixture.");
  }finally{await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;await sql`DELETE FROM employees WHERE id=${driverId}`}
}
main().catch(error=>{console.error(error);process.exitCode=1});
