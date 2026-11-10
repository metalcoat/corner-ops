#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { localValidationEnv } from "./validation-env";
localValidationEnv();
const rollback="rollback:driver-cash";
async function main(){
  const[{getSql,withTransaction},{ensureDriverDeliverySchema},{driverCashDashboard,postDriverCashSettlement}]=await Promise.all([import("../src/lib/db"),import("../src/lib/ordering-driver-delivery"),import("../src/lib/ordering-driver-cash")]);
  await ensureDriverDeliverySchema();
  const cashierId=randomUUID(),actor={business:"Corner Deli",employeeId:cashierId,name:"Cashier Employee",manager:false,driver:false} as any;
  const result:Record<string,boolean>={};
  const clientSource=readFileSync(new URL("../src/app/pos/deli/drivers/driver-cash-client.tsx",import.meta.url),"utf8");
  assert.match(clientSource,/DRIVER CASH CHECKOUT/);assert.match(clientSource,/driverCashNumpad/);assert.match(clientSource,/CASH OUT/);result.unifiedNumpadCheckout=true;
  try{await withTransaction(async()=>{
    const sql=getSql(),driverId=randomUUID(),orderId=randomUUID(),deliveryId=randomUUID(),suffix=randomUUID().slice(0,6);
    await sql`INSERT INTO employees(id,business,name,pin_hash,position,role_group,active)VALUES(${driverId},'Corner Deli',${`Cash Driver ${suffix}`},${`driver-${suffix}`},'Driver','Driver',TRUE),(${cashierId},'Corner Deli',${actor.name},${`cashier-${suffix}`},'Cashier','In-House',TRUE)`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,total_cents,amount_due_cents,submitted_at)VALUES(${orderId},'Corner Deli','pos','completed','unpaid','delivery',${`CASH-${suffix}`},'driver-cash-test','Cash','Customer','3155550199',2500,2500,NOW())`;
    await sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles,route_duration_seconds,route_provider,route_calculated_at)VALUES(${orderId},'100 Cashout St','100 Cashout St, Ogdensburg, NY 13669','100 Cashout St','Ogdensburg','NY','13669',44.69,-75.48,'fixture','validated',NOW(),1.5,420,'fixture',NOW())`;
    await assert.rejects(()=>driverCashDashboard(actor),/Driver or manager access/);
    await assert.rejects(()=>postDriverCashSettlement(actor,{orderIds:[orderId],turnedInCashCents:2500,businessDate:"2026-08-25"}),/Driver or manager access/);result.nonDriverCashierRejected=true;
    const driver={business:"Corner Deli",employeeId:driverId,name:`Cash Driver ${suffix}`,manager:false,driver:true} as any,manager={business:"Corner Deli",employeeId:cashierId,name:"Cash Manager",manager:true,driver:false} as any;
    assert.equal((await driverCashDashboard(driver)).orders.some(row=>row.order_id===orderId),false);
    await assert.rejects(()=>postDriverCashSettlement(driver,{orderIds:[orderId],turnedInCashCents:2500,businessDate:"2026-08-25"}),/assigned to them/);result.driverLimitedToAssignedOrders=true;
    const dashboard=await driverCashDashboard(manager),listed=dashboard.orders.find(row=>row.order_id===orderId);assert.ok(listed);assert.equal(listed.customer_name,"Cash Customer");assert.match(String(listed.delivery_address),/100 Cashout St/);result.eligibleOrderListed=true;result.customerIdentityIncluded=true;
    assert.equal(listed.delivery_status,null);result.dispatchAppNotRequired=true;
    await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,driver_employee_id,status,assigned_by)VALUES(${deliveryId},${orderId},'Corner Deli',${driverId},'DELIVERED','validation')`;
    assert.equal((await driverCashDashboard(driver)).orders.some(row=>row.order_id===orderId),true);
    await assert.rejects(()=>postDriverCashSettlement(driver,{orderIds:[orderId],turnedInCashCents:0,businessDate:"2026-08-25"}),/manager must approve/);result.shortCashOutNeedsManager=true;
    // Driver cash goes in the back drawer; the back till has to be open.
    const backTill=(await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash)VALUES(${randomUUID()},'Corner Deli','back-register','back-register','pos','Back pos 1',TRUE) ON CONFLICT(business,terminal_key) DO UPDATE SET active=TRUE RETURNING id`)[0],sessionId=randomUUID();
    await sql`UPDATE ordering_register_sessions SET status='closed',closed_at=NOW() WHERE terminal_id=${backTill.id} AND status<>'closed'`;
    await assert.rejects(()=>postDriverCashSettlement(driver,{orderIds:[orderId],turnedInCashCents:2500,businessDate:"2026-08-25"}),/Open the back till/);result.backTillMustBeOpen=true;
    await sql`INSERT INTO ordering_register_sessions(id,business,terminal_id,status,opening_cash_cents,expected_cash_cents,opened_by)VALUES(${sessionId},'Corner Deli',${backTill.id},'open',0,0,'validation')`;
    const posted=await postDriverCashSettlement(driver,{orderIds:[orderId],turnedInCashCents:2600,businessDate:"2026-08-25"});
    assert.equal(posted.expectedCashCents,2500);assert.equal(posted.overShortCents,100);
    const order=(await sql`SELECT payment_status,amount_due_cents FROM ordering_orders WHERE id=${orderId}`)[0],settlement=(await sql`SELECT status,order_count,expected_cash_cents,turned_in_cash_cents,over_short_cents,created_by,approved_by FROM ordering_driver_cash_settlements WHERE id=${posted.id}`)[0];
    assert.equal(order.payment_status,"paid");assert.equal(Number(order.amount_due_cents),0);assert.deepEqual([settlement.status,Number(settlement.order_count),Number(settlement.expected_cash_cents),Number(settlement.turned_in_cash_cents),Number(settlement.over_short_cents)],["posted",1,2500,2600,100]);
    assert.equal(settlement.created_by,driver.employeeId);assert.equal(settlement.approved_by,driver.employeeId);
    result.assignedDriverCanSettle=true;result.loggedInEmployeeAudited=true;result.bulkSettlementPostsPayments=true;result.overShortAudited=true;
    // Every unpaid delivery is listed even when tracking wasn't used; once the driver picks it up, the row shows who took it and when.
    const otherDriverId=randomUUID(),kitchenId=randomUUID(),otherId=randomUUID(),addOrder=async(id:string,status:string,number:string)=>{await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,total_cents,amount_due_cents,submitted_at)VALUES(${id},'Corner Deli','pos',${status},'unpaid','delivery',${number},'driver-cash-test','Cash','Customer','3155550199',1000,1000,NOW())`};
    await sql`INSERT INTO employees(id,business,name,pin_hash,position,role_group,active)VALUES(${otherDriverId},'Corner Deli',${`Other Driver ${suffix}`},${`other-${suffix}`},'Driver','Driver',TRUE)`;
    await addOrder(kitchenId,'sent_to_kitchen',`KIT-${suffix}`);await addOrder(otherId,'ready',`OTH-${suffix}`);
    await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,driver_employee_id,status,assigned_by)VALUES(${randomUUID()},${kitchenId},'Corner Deli',${driverId},'READY_FOR_DRIVER','validation'),(${randomUUID()},${otherId},'Corner Deli',${otherDriverId},'EN_ROUTE','validation')`;
    await sql`UPDATE ordering_delivery_assignments SET picked_up_at=NOW() WHERE order_id=${otherId}`;
    const notTaken=(await driverCashDashboard(manager)).orders.find(row=>row.order_id===kitchenId);assert.ok(notTaken);assert.equal(notTaken.taken_at,null);result.untrackedOrdersStillListed=true;
    await sql`UPDATE ordering_delivery_assignments SET status='PICKED_UP',picked_up_at=NOW() WHERE order_id=${kitchenId}`;
    const taken=(await driverCashDashboard(manager)).orders.find(row=>row.order_id===kitchenId);assert.ok(taken);assert.equal(taken.driver_name,driver.name);assert.ok(taken.taken_at);result.takenByAndWhenShown=true;
    // Driver cash goes in the back drawer; the back till has to be open.
    // Select all across drivers: a short needs a reason, each order keeps its own driver.
    await assert.rejects(()=>postDriverCashSettlement(manager,{orderIds:[kitchenId,otherId],turnedInCashCents:1500,businessDate:"2026-08-25"}),/reason for the short cash/);result.shortNeedsReason=true;
    const mixed=await postDriverCashSettlement(manager,{orderIds:[kitchenId,otherId],turnedInCashCents:1500,businessDate:"2026-08-25",shortReason:"Customer short $5"});
    const header=(await sql`SELECT driver_employee_id,created_by,notes,register_session_id FROM ordering_driver_cash_settlements WHERE id=${mixed.id}`)[0];
    assert.equal(header.created_by,manager.employeeId);assert.equal(header.notes,"Customer short $5");assert.equal(header.register_session_id,sessionId);
    const lines=await sql`SELECT order_id,driver_employee_id FROM ordering_driver_cash_settlement_orders WHERE settlement_id=${mixed.id}`;
    assert.equal(lines.find(line=>line.order_id===kitchenId)?.driver_employee_id,driverId);assert.equal(lines.find(line=>line.order_id===otherId)?.driver_employee_id,otherDriverId);result.eachOrderKeepsItsDriver=true;
    const drawer=(await sql`SELECT expected_cash_cents FROM ordering_register_sessions WHERE id=${sessionId}`)[0],movements=await sql`SELECT movement_type,delta_cash_cents FROM ordering_cash_drawer_movements WHERE register_session_id=${sessionId} ORDER BY delta_cash_cents`;
    assert.equal(Number(drawer.expected_cash_cents),4000);assert.deepEqual(movements.map(row=>[row.movement_type,Number(row.delta_cash_cents)]),[["driver_turn_in",1500],["driver_turn_in",2500]]);result.cashAddedToBackTill=true;
    const recent=(await driverCashDashboard(manager)).settlements.find(row=>row.id===mixed.id);assert.ok(recent);assert.match(String(recent.driver_names),/Other Driver/);assert.equal(recent.handled_by_name,"Cashier Employee");
    throw new Error(rollback);
  })}catch(error){if(!(error instanceof Error)||error.message!==rollback)throw error}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
