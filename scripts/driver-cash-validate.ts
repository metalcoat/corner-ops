#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();
const rollback="rollback:driver-cash";
async function main(){
  const[{getSql,withTransaction},{ensureDriverDeliverySchema},{driverCashDashboard,postDriverCashSettlement}]=await Promise.all([import("../src/lib/db"),import("../src/lib/ordering-driver-delivery"),import("../src/lib/ordering-driver-cash")]);
  await ensureDriverDeliverySchema();
  const actor={business:"Corner Deli",employeeId:"driver-cash-manager",name:"Cash Manager",manager:true,driver:false} as any;
  const result:Record<string,boolean>={};
  try{await withTransaction(async()=>{
    const sql=getSql(),driverId=randomUUID(),orderId=randomUUID(),deliveryId=randomUUID(),suffix=randomUUID().slice(0,6);
    await sql`INSERT INTO employees(id,business,name,pin_hash,position,role_group,active)VALUES(${driverId},'Corner Deli',${`Cash Driver ${suffix}`},'','Driver','Driver',TRUE)`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,created_by,first_name_snapshot,last_name_snapshot,phone_snapshot,total_cents,amount_due_cents)VALUES(${orderId},'Corner Deli','pos','completed','unpaid','delivery',${`CASH-${suffix}`},'driver-cash-test','Cash','Customer','3155550199',2500,2500)`;
    await sql`INSERT INTO ordering_delivery_assignments(id,order_id,business,driver_employee_id,status,cash_expected_cents,assigned_by,delivered_at)VALUES(${deliveryId},${orderId},'Corner Deli',${driverId},'DELIVERED',2500,'driver-cash-test',NOW())`;
    const dashboard=await driverCashDashboard(actor);assert.ok(dashboard.orders.some(row=>row.order_id===orderId));result.eligibleOrderListed=true;
    const posted=await postDriverCashSettlement(actor,{driverId,orderIds:[orderId],turnedInCashCents:2600,businessDate:"2026-08-25"});
    assert.equal(posted.expectedCashCents,2500);assert.equal(posted.overShortCents,100);
    const order=(await sql`SELECT payment_status,amount_due_cents FROM ordering_orders WHERE id=${orderId}`)[0],settlement=(await sql`SELECT status,order_count,expected_cash_cents,turned_in_cash_cents,over_short_cents FROM ordering_driver_cash_settlements WHERE id=${posted.id}`)[0];
    assert.equal(order.payment_status,"paid");assert.equal(Number(order.amount_due_cents),0);assert.deepEqual([settlement.status,Number(settlement.order_count),Number(settlement.expected_cash_cents),Number(settlement.turned_in_cash_cents),Number(settlement.over_short_cents)],["posted",1,2500,2600,100]);
    result.bulkSettlementPostsPayments=true;result.overShortAudited=true;
    throw new Error(rollback);
  })}catch(error){if(!(error instanceof Error)||error.message!==rollback)throw error}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
