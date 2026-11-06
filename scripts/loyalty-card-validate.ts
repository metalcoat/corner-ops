import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { OrderLoyaltyCard } from "../src/lib/ordering-loyalty-card";

if(!process.env.VALIDATION_DATABASE_URL||process.env.ORDERING_AUDIT_DATABASE!=="1")throw new Error("An explicitly isolated audit database is required.");
process.env.DATABASE_URL=process.env.VALIDATION_DATABASE_URL;
process.env.DATABASE_DRIVER="postgres";
process.env.SESSION_SECRET||=randomUUID();
Object.assign(globalThis,{AsyncLocalStorage});

async function main(){
  const {getSql}=await import('../src/lib/db');
  const {GET}=await import('../src/app/api/ordering/orders/[id]/loyalty-card/route');
  const {encodePosSession,POS_COOKIE}=await import('../src/lib/pos-auth');
  const {workAsyncStorage}=await import('next/dist/server/app-render/work-async-storage.external');
  const {workUnitAsyncStorage}=await import('next/dist/server/app-render/work-unit-async-storage.external');
  const {createRequestStoreForAPI}=await import('next/dist/server/async-storage/request-store');
  const sql=getSql(),employee=randomUUID(),customer=randomUUID(),otherCustomer=randomUUID(),tikiCustomer=randomUUID(),program=randomUUID(),order=randomUUID(),recentOrder=randomUUID(),otherOrder=randomUUID(),tikiOrder=randomUUID(),guestOrder=randomUUID();
  const customers=[customer,otherCustomer,tikiCustomer],orders=[order,recentOrder,otherOrder,tikiOrder,guestOrder];
  const [settings]=await sql`SELECT active,expiry_months FROM ordering_points_settings WHERE business='Corner Deli'`;
  const now=Date.now(),cookie=encodePosSession({employeeId:employee,business:'Corner Deli',name:'Loyalty card test',position:'Test',posRole:'employee',issuedAt:now,expiresAt:now+60_000,clockInRequired:false});
  const call=async(id:string,token=cookie,query='')=>{
    const request=new Request(`http://localhost/api/ordering/orders/${id}/loyalty-card${query}`,{headers:token?{cookie:`${POS_COOKIE}=${token}`}:{}});
    const store=createRequestStoreForAPI(request as unknown as Parameters<typeof createRequestStoreForAPI>[0],new URL(request.url),{tags:[],expirationsByCacheKind:new Map()},undefined,undefined,undefined);
    const work={route:'/api/ordering/orders/[id]/loyalty-card'} as Parameters<typeof workAsyncStorage.run>[0];
    return workAsyncStorage.run(work,()=>workUnitAsyncStorage.run(store,()=>GET(request,{params:Promise.resolve({id})})));
  };
  let checks=0;
  try{
    await sql`INSERT INTO employees(id,business,name,pin_hash,pin_enabled,position,role_group,active,pos_role) VALUES(${employee},'Corner Deli','Loyalty card test',${randomUUID()},TRUE,'Test','In-House',TRUE,'employee')`;
    for(const id of customers)await sql`INSERT INTO ordering_customers(id,business,display_name) VALUES(${id},${id===tikiCustomer?'Tiki':'Corner Deli'},${id===customer?'Selected customer':'Other customer'})`;
    await sql`INSERT INTO ordering_points_settings(business) VALUES('Corner Deli') ON CONFLICT DO NOTHING`;
    await sql`UPDATE ordering_points_settings SET active=TRUE,expiry_months=6 WHERE business='Corner Deli'`;
    await sql`INSERT INTO ordering_loyalty_programs(id,business,name,customer_name,qualifying_rule,reward_rule,active) VALUES(${program},'Corner Deli',${`Jumbo card regression ${program}`},'Jumbo card regression','{"quantityRequired":10}'::jsonb,'{}'::jsonb,TRUE)`;
    for(const id of orders)await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,created_by,total_cents,paid_cents,amount_due_cents) VALUES(${id},${id===tikiOrder?'Tiki':'Corner Deli'},'web',${id===guestOrder?null:id===tikiOrder?tikiCustomer:id===otherOrder?otherCustomer:customer},'sent_to_kitchen','paid','pickup',${`CARD-${id.slice(0,8)}`},'loyalty-card-validator',1000,1000,0)`;
    const pointRedeem=randomUUID(),loyaltyRedeem=randomUUID();
    for(let i=0;i<26;i++){
      const type=i===0?'earn':i===1?'redeem':i===2?'reversal':'adjustment',amount=i===0?10:i===1?-3:i===2?3:1;
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,related_event_id,description,reason,created_by,created_at) VALUES(${i===1?pointRedeem:randomUUID()},'Corner Deli',${customer},${order},${type},${amount},${i===2?pointRedeem:null},'Selected order points','Fixture reason','validator',NOW()-INTERVAL '1 year')`;
      await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,order_id,entry_type,delta_units,related_event_id,description,reason,created_by,created_at) VALUES(${i===1?loyaltyRedeem:randomUUID()},'Corner Deli',${program},${customer},${order},${i===2?'redemption_reversal':type},${amount},${i===2?loyaltyRedeem:null},'Selected order punches','Fixture reason','validator',NOW()-INTERVAL '1 year')`;
    }
    for(let i=0;i<25;i++){
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,description,created_by) VALUES(${randomUUID()},'Corner Deli',${customer},${recentOrder},${i===0?'earn':'adjustment'},1,'Recent points','validator')`;
      await sql`INSERT INTO ordering_loyalty_ledger(id,business,program_id,customer_id,order_id,entry_type,delta_units,description,created_by) VALUES(${randomUUID()},'Corner Deli',${program},${customer},${recentOrder},'manager_adjustment',1,'Recent punches','validator')`;
    }
    await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,description,created_by) VALUES(${randomUUID()},'Corner Deli',${otherCustomer},${otherOrder},'earn',9876,'Must not leak','validator')`;
    assert.equal((await call(order,'')).status,401);assert.equal((await call(order,`${cookie}invalid`)).status,401);checks++;
    const response=await call(order,cookie,`?customerId=${otherCustomer}&business=Tiki`),card=await response.json() as OrderLoyaltyCard;
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(card.customer?.id,customer);assert.equal(card.customer?.name,'Selected customer');assert.equal(card.points.balance,58);assert.equal(card.programs.find(row=>row.id===program)?.units,58);checks++;
    assert.equal(card.thisOrder.points.length,26);assert.equal(card.thisOrder.loyalty.length,26);assert.equal(card.history.points.length,20);assert.equal(card.history.loyalty.length,20);assert.ok(card.history.points.every(row=>row.orderId===recentOrder));assert.ok(card.thisOrder.points.every(row=>row.orderId===order&&row.createdAt.endsWith('Z')&&row.orderNumber?.startsWith('CARD-')));assert.ok(card.thisOrder.loyalty.every(row=>row.programName==='Jumbo card regression'));assert.ok(card.thisOrder.points.some(row=>row.amount<0));assert.ok(card.thisOrder.points.some(row=>row.type==='reversal'));checks++;
    assert.equal((await call(tikiOrder)).status,404);assert.equal((await call(randomUUID())).status,404);checks++;
    const guest=await (await call(guestOrder)).json() as OrderLoyaltyCard;assert.equal(guest.customer,null);assert.ok(guest.notes.some(row=>row.code==='no_customer'));assert.deepEqual(guest.thisOrder,{points:[],loyalty:[]});checks++;
    await sql`UPDATE ordering_orders SET payment_status='unpaid',paid_cents=0,amount_due_cents=1000 WHERE id=${order}`;
    const unpaid=await (await call(order)).json() as OrderLoyaltyCard;assert.ok(unpaid.notes.some(row=>row.code==='not_fully_paid'));assert.ok(unpaid.notes.some(row=>row.code==='no_points_items'));checks++;
    await sql`UPDATE ordering_orders SET payment_status='refunded',amount_due_cents=0 WHERE id=${order}`;
    const refunded=await (await call(order)).json() as OrderLoyaltyCard;assert.ok(refunded.notes.some(row=>row.code==='refunded'));checks++;
    await sql`UPDATE ordering_points_ledger SET created_at=NOW()-INTERVAL '1 year' WHERE customer_id=${customer}`;
    const [before]=await sql`SELECT COUNT(*) count,SUM(points) total FROM ordering_points_ledger WHERE customer_id=${customer}`;
    const expired=await (await call(order)).json() as OrderLoyaltyCard;
    const [after]=await sql`SELECT COUNT(*) count,SUM(points) total FROM ordering_points_ledger WHERE customer_id=${customer}`;
    assert.equal(expired.points.balance,0);assert.equal(expired.points.expired,true);assert.deepEqual(after,before);checks++;
    await sql`UPDATE employees SET pin_enabled=FALSE WHERE id=${employee}`;assert.equal((await call(order)).status,401);checks++;
    console.log(JSON.stringify({checks,realPosAuth:true,orderCustomerScoped:true,crossBusinessBlocked:true,completeOrderHistory:true,readOnlyExpiry:true},null,2));
  }finally{
    await sql`DELETE FROM ordering_points_ledger WHERE customer_id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_loyalty_ledger WHERE customer_id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_orders WHERE id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_customers WHERE id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_loyalty_programs WHERE id=${program}`;
    await sql`DELETE FROM employees WHERE id=${employee}`;
    if(settings)await sql`UPDATE ordering_points_settings SET active=${settings.active},expiry_months=${settings.expiry_months} WHERE business='Corner Deli'`;
    else await sql`DELETE FROM ordering_points_settings WHERE business='Corner Deli'`;
  }
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
