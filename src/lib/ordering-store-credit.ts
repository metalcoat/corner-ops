import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";

export async function customerCredit(customerId: string) {
  await ensureOrderingPosSchema();
  const rows = await getSql()`SELECT COALESCE(SUM(delta_balance_cents) FILTER(WHERE expires_at IS NULL OR expires_at>NOW()),0)::integer balance_cents,(SELECT reason FROM ordering_store_credit_ledger recent WHERE recent.customer_id=${customerId} AND recent.delta_balance_cents>0 ORDER BY recent.created_at DESC LIMIT 1) reason FROM ordering_store_credit_ledger WHERE business='Corner Deli' AND customer_id=${customerId}`;
  return { balanceCents: Number(rows[0]?.balance_cents || 0), reason: String(rows[0]?.reason || "") };
}

export async function issueCustomerCredit(input:{customerId:string;orderId?:string;amountCents:number;reason:string;actor:OrderingActor}) {
  if (!canManagePos(input.actor)) throw new Error("Manager access is required to issue customer credit.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Enter a valid credit amount.");
  if (input.reason.trim().length < 3) throw new Error("Enter the reason for this credit.");
  await ensureOrderingPosSchema();
  const customer=(await getSql()`SELECT id FROM ordering_customers WHERE id=${input.customerId} AND business='Corner Deli' AND active=TRUE`)[0];
  if(!customer)throw new Error("Attach this order to a customer before issuing credit.");
  await getSql()`INSERT INTO ordering_store_credit_ledger(id,business,customer_id,order_id,entry_type,delta_balance_cents,reason,created_by,approved_by) VALUES(${randomUUID()},'Corner Deli',${input.customerId},${input.orderId||null},'issue',${input.amountCents},${input.reason.trim()},${input.actor.id},${input.actor.name})`;
  return customerCredit(input.customerId);
}

export async function redeemCustomerCredit(input:{orderId:string;checkId?:string|null;actor:OrderingActor}) {
  await ensureOrderingPosSchema();
  return withTransaction(async()=>{
    const sql=getSql(),order=(await sql`SELECT id,customer_id,amount_due_cents,paid_cents,total_cents,version FROM ordering_orders WHERE id=${input.orderId} AND business='Corner Deli' FOR UPDATE`)[0];
    if(!order?.customer_id)throw new Error("Attach a customer before applying account credit.");
    const balanceRows=await sql`SELECT COALESCE(SUM(delta_balance_cents) FILTER(WHERE expires_at IS NULL OR expires_at>NOW()),0)::integer balance FROM ordering_store_credit_ledger WHERE business='Corner Deli' AND customer_id=${order.customer_id}`;
    const check=input.checkId?(await sql`SELECT id,amount_due_cents,paid_cents,total_cents FROM ordering_checks WHERE id=${input.checkId} AND order_id=${input.orderId} FOR UPDATE`)[0]:null;
    const due=Number(check?.amount_due_cents??order.amount_due_cents),amount=Math.min(due,Number(balanceRows[0]?.balance||0));
    if(amount<=0)throw new Error("This customer has no available credit for this check.");
    const transactionId=randomUUID();
    await sql`INSERT INTO ordering_store_credit_ledger(id,business,customer_id,order_id,entry_type,delta_balance_cents,reason,created_by) VALUES(${randomUUID()},'Corner Deli',${order.customer_id},${input.orderId},'redeem',${-amount},'Applied to order',${input.actor.id})`;
    await sql`INSERT INTO ordering_payment_transactions(id,business,order_id,check_id,customer_id,tender_type,transaction_type,status,amount_cents,amount_tendered_cents,provider,client_mutation_id,created_by,approved_at,details) VALUES(${transactionId},'Corner Deli',${input.orderId},${input.checkId||null},${order.customer_id},'store_credit','payment','approved',${amount},${amount},'corner_ops_store_credit',${`store-credit:${randomUUID()}`},${input.actor.id},NOW(),${JSON.stringify({reason:'Customer account credit'})}::jsonb)`;
    if(check)await sql`UPDATE ordering_checks SET paid_cents=paid_cents+${amount},amount_due_cents=GREATEST(0,amount_due_cents-${amount}),status=CASE WHEN amount_due_cents-${amount}<=0 THEN 'paid' ELSE 'partially_paid' END,updated_at=NOW() WHERE id=${check.id}`;
    await sql`UPDATE ordering_orders SET paid_cents=paid_cents+${amount},amount_due_cents=GREATEST(0,amount_due_cents-${amount}),payment_status=CASE WHEN amount_due_cents-${amount}<=0 THEN 'paid' ELSE 'partially_paid' END,version=version+1,updated_at=NOW() WHERE id=${input.orderId}`;
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'store_credit_applied',${input.actor.type},${input.actor.id},${JSON.stringify({amountCents:amount,transactionId})}::jsonb FROM ordering_orders WHERE id=${input.orderId}`;
    return {appliedCents:amount,credit:{balanceCents:Number(balanceRows[0]?.balance||0)-amount,reason:""}};
  });
}
