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
    const dashboard=await driverCashDashboard(actor),listed=dashboard.orders.find(row=>row.order_id===orderId);assert.ok(listed);assert.equal(listed.customer_name,"Cash Customer");assert.match(String(listed.delivery_address),/100 Cashout St/);result.eligibleOrderListed=true;result.customerIdentityIncluded=true;
    assert.equal(listed.delivery_status,null);result.dispatchAppNotRequired=true;
    const posted=await postDriverCashSettlement(actor,{orderIds:[orderId],turnedInCashCents:2600,businessDate:"2026-08-25"});
    assert.equal(posted.expectedCashCents,2500);assert.equal(posted.overShortCents,100);
    const order=(await sql`SELECT payment_status,amount_due_cents FROM ordering_orders WHERE id=${orderId}`)[0],settlement=(await sql`SELECT status,order_count,expected_cash_cents,turned_in_cash_cents,over_short_cents,created_by,approved_by FROM ordering_driver_cash_settlements WHERE id=${posted.id}`)[0];
    assert.equal(order.payment_status,"paid");assert.equal(Number(order.amount_due_cents),0);assert.deepEqual([settlement.status,Number(settlement.order_count),Number(settlement.expected_cash_cents),Number(settlement.turned_in_cash_cents),Number(settlement.over_short_cents)],["posted",1,2500,2600,100]);
    assert.equal(settlement.created_by,actor.employeeId);assert.equal(settlement.approved_by,actor.employeeId);
    result.anyLoggedInEmployeeCanSettle=true;result.loggedInEmployeeAudited=true;result.bulkSettlementPostsPayments=true;result.overShortAudited=true;
    throw new Error(rollback);
  })}catch(error){if(!(error instanceof Error)||error.message!==rollback)throw error}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
