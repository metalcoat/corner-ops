import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { ensureOrderingGiftCardSchema } from "@/lib/ordering-gift-card-schema";
import { GiftCardError, redeemGiftCard } from "@/lib/ordering-gift-cards";
import { canManagePos } from "@/lib/ordering-route-auth";
import type { PaymentProviderKey } from "@/lib/payment-provider";
import { completePaidPaymentQueue } from "@/lib/ordering-payment-stations";
import { ensureOrderingAddressSchema } from "@/lib/ordering-address-schema";

export type CheckoutTenderType = "cash" | "card" | "gift_card";

export class PaymentConflictError extends Error {}

export async function assertOrderReadyForCheckout(orderId: string, business: OrderingBusiness) {
  if (business !== "Corner Deli") return;
  await ensureOrderingAddressSchema();
  const sql = getSql();
  const order = (await sql`
    SELECT first_name_snapshot, last_name_snapshot, phone_snapshot, service_type
    FROM ordering_orders WHERE id=${orderId} AND business=${business} LIMIT 1
  `)[0];
  if (!order) throw new PaymentConflictError("Order was not found.");
  const customerName = `${order.first_name_snapshot || ""} ${order.last_name_snapshot || ""}`.trim();
  if (!customerName) throw new PaymentConflictError("Customer name is required before checkout.");
  if (["pickup", "delivery", "no_contact_delivery"].includes(String(order.service_type)) && !String(order.phone_snapshot || "").trim()) {
    throw new PaymentConflictError(order.service_type === "pickup"
      ? "Phone number is required for pickup orders."
      : "Phone number is required for delivery orders.");
  }
  if (["delivery", "no_contact_delivery"].includes(String(order.service_type))) {
    const address = (await sql`
      SELECT validation_status, route_distance_miles
      FROM ordering_order_delivery_addresses WHERE order_id=${orderId} LIMIT 1
    `)[0];
    if (address?.validation_status !== "validated") throw new PaymentConflictError("Delivery address is required before checkout.");
    if (address.route_distance_miles == null) throw new PaymentConflictError("Driving distance is required before checkout.");
  }
}

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PaymentConflictError(`${label} must be a positive amount in cents.`);
  return value;
}

export async function setCheckoutTip(input: {
  orderId: string;
  business: OrderingBusiness;
  checkId?: string | null;
  tipCents: number;
  actor: OrderingActor;
}) {
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0)
    throw new PaymentConflictError("Tip must be a non-negative amount in cents.");
  await ensureOrderingAccountSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const order = (await sql`SELECT id,tip_cents,total_cents,paid_cents FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`)[0];
    if (!order) throw new PaymentConflictError("Order was not found.");
    const delta = input.tipCents - Number(order.tip_cents);
    if (input.checkId) {
      const check = (await sql`SELECT id FROM ordering_checks WHERE id=${input.checkId} AND order_id=${input.orderId} FOR UPDATE`)[0];
      if (!check) throw new PaymentConflictError("Check was not found.");
      await sql`UPDATE ordering_checks SET total_cents=GREATEST(0,total_cents+${delta}),amount_due_cents=GREATEST(0,total_cents+${delta}-paid_cents),status=CASE WHEN total_cents+${delta}-paid_cents<=0 THEN 'paid' WHEN paid_cents>0 THEN 'partially_paid' ELSE 'open' END,updated_at=NOW() WHERE id=${input.checkId}`;
    }
    const total = Math.max(0, Number(order.total_cents) + delta);
    const due = Math.max(0, total - Number(order.paid_cents));
    await sql`UPDATE ordering_orders SET tip_cents=${input.tipCents},total_cents=${total},amount_due_cents=${due},payment_status=CASE WHEN ${due}=0 THEN 'paid' WHEN paid_cents>0 THEN 'partially_paid' ELSE 'unpaid' END,version=version+1,updated_at=NOW() WHERE id=${input.orderId}`;
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'tip_updated',${input.actor.type},${input.actor.id},${JSON.stringify({ tipCents: input.tipCents })}::jsonb FROM ordering_orders WHERE id=${input.orderId}`;
    return checkoutState(input.orderId, input.business, input.checkId);
  });
}

export async function checkoutState(orderId: string, business: OrderingBusiness, checkId?: string | null) {
  await ensureOrderingAccountSchema();
  const sql = getSql();
  const orders = await sql`
    SELECT id, display_number, status, payment_status, total_cents, paid_cents, amount_due_cents, paid_at
    FROM ordering_orders WHERE id = ${orderId} AND business = ${business} LIMIT 1
  `;
  if (!orders[0]) throw new PaymentConflictError("Order was not found.");
  const tenders = await sql`
    SELECT id, tender_type, transaction_type, status, amount_cents, amount_tendered_cents, change_due_cents,
           brand, last4, related_transaction_id, reason, created_by, created_at, approved_at
    FROM ordering_payment_transactions
    WHERE order_id = ${orderId} AND business = ${business} AND (${checkId || null}::uuid IS NULL OR check_id=${checkId || null})
    ORDER BY created_at, id
  `;
  const check = checkId ? (await sql`SELECT id,display_sequence,status,total_cents,paid_cents,amount_due_cents FROM ordering_checks WHERE id=${checkId} AND order_id=${orderId}`)[0] : null;
  if (checkId && !check) throw new PaymentConflictError("Check was not found.");
  return { order: orders[0], check, tenders };
}

function reason(value: string, action: string): string {
  const cleaned = value.trim();
  if (cleaned.length < 3) throw new PaymentConflictError(`A ${action} reason is required.`);
  if (cleaned.length > 500) throw new PaymentConflictError(`${action[0].toUpperCase()}${action.slice(1)} reason must be 500 characters or fewer.`);
  return cleaned;
}

export async function reverseTender(input: { orderId: string; business: OrderingBusiness; transactionId: string; amountCents: number; clientMutationId: string; reason: string; actor: OrderingActor }) {
  if (!canManagePos(input.actor)) throw new PaymentConflictError("Manager or owner authorization is required to reverse a tender.");
  const reversalReason = reason(input.reason, "reversal");
  const amount = cents(input.amountCents, "Reversal amount");
  if (!input.clientMutationId.trim() || input.clientMutationId.length > 160) throw new PaymentConflictError("A valid reversal request ID is required.");
  await ensureOrderingGiftCardSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const duplicate = await sql`SELECT id,order_id,transaction_type,related_transaction_id FROM ordering_payment_transactions WHERE business=${input.business} AND client_mutation_id=${input.clientMutationId}`;
    if (duplicate[0]) {
      if (duplicate[0].order_id !== input.orderId || duplicate[0].transaction_type !== "void" || duplicate[0].related_transaction_id !== input.transactionId) throw new PaymentConflictError("That reversal request ID was already used for another operation.");
      return { ...(await checkoutState(input.orderId, input.business)), duplicate: true };
    }
    const source = (await sql`SELECT * FROM ordering_payment_transactions WHERE id=${input.transactionId} AND order_id=${input.orderId} AND business=${input.business} FOR UPDATE`)[0];
    if (!source || source.transaction_type !== "payment" || source.status !== "approved") throw new PaymentConflictError("Approved payment tender was not found.");
    if (source.tender_type === "card" && source.provider && source.provider !== "test") throw new PaymentConflictError(`${source.provider === "mx_merchant" ? "Dharma / MX Merchant" : "Helcim"} card reversals must be approved by the processor before the local payment record is updated.`);
    const reversed = Number((await sql`SELECT COALESCE(SUM(amount_cents),0) amount FROM ordering_payment_transactions WHERE related_transaction_id=${source.id} AND transaction_type='void' AND status='approved'`)[0].amount);
    if (amount > Number(source.amount_cents) - reversed) throw new PaymentConflictError("Reversal exceeds the tender's unreversed amount.");
    const order = (await sql`SELECT * FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`)[0];
    if (!order) throw new PaymentConflictError("Order was not found.");
    const reversalId = randomUUID();
    await sql`INSERT INTO ordering_payment_transactions(id,business,order_id,check_id,customer_id,tender_type,transaction_type,status,amount_cents,amount_tendered_cents,provider,related_transaction_id,client_mutation_id,created_by,approved_at,reason,details) VALUES(${reversalId},${input.business},${input.orderId},${source.check_id},${source.customer_id},${source.tender_type},'void','approved',${amount},${amount},${source.provider},${source.id},${input.clientMutationId},${input.actor.id},NOW(),${reversalReason},${JSON.stringify({actorName:input.actor.name,actorRole:input.actor.role,partial:amount<Number(source.amount_cents)-reversed})}::jsonb)`;
    if (source.tender_type === "gift_card") {
      const ledger = (await sql`SELECT ledger.*,card.current_balance_cents,card.status FROM ordering_gift_card_ledger ledger JOIN ordering_gift_cards card ON card.id=ledger.gift_card_id WHERE ledger.payment_transaction_id=${source.id} AND ledger.entry_type='redeem' FOR UPDATE OF card`)[0];
      if (!ledger) throw new PaymentConflictError("Gift-card redemption ledger was not found.");
      const balance = Number(ledger.current_balance_cents) + amount;
      await sql`INSERT INTO ordering_gift_card_ledger(id,gift_card_id,business,order_id,entry_type,delta_balance_cents,balance_after_cents,payment_transaction_id,operation_key,related_entry_id,created_by,approved_by,note,metadata) VALUES(${randomUUID()},${ledger.gift_card_id},${input.business},${input.orderId},'reversal',${amount},${balance},${reversalId},${`payment-reversal:${input.clientMutationId}`},${ledger.id},${input.actor.id},${input.actor.id},${reversalReason},${JSON.stringify({sourcePaymentId:source.id,partial:amount<Number(source.amount_cents)-reversed})}::jsonb)`;
      await sql`UPDATE ordering_gift_cards SET current_balance_cents=${balance},status=CASE WHEN status='depleted' THEN 'active' ELSE status END WHERE id=${ledger.gift_card_id}`;
    }
    if(source.tender_type==="cash"&&source.details?.registerSessionId){
      const registerSessionId=String(source.details.registerSessionId),movementId=randomUUID();
      await sql`INSERT INTO ordering_cash_drawer_movements(id,register_session_id,order_id,payment_transaction_id,movement_type,delta_cash_cents,reason,created_by,approved_by,details) SELECT ${movementId},id,${input.orderId},${reversalId},'refund',${-amount},${reversalReason},${input.actor.id},${input.actor.id},${JSON.stringify({sourcePaymentId:source.id})}::jsonb FROM ordering_register_sessions WHERE id=${registerSessionId}`;
      await sql`UPDATE ordering_register_sessions SET expected_cash_cents=GREATEST(0,expected_cash_cents-${amount}) WHERE id=${registerSessionId}`;
    }
    const newPaid = Math.max(0, Number(order.paid_cents) - amount), remaining = Math.max(0, Number(order.total_cents) - newPaid);
    const paymentStatus = newPaid === 0 ? "unpaid" : remaining === 0 ? "paid" : "partially_paid";
    await sql`UPDATE ordering_orders SET paid_cents=${newPaid},amount_due_cents=${remaining},payment_status=${paymentStatus},paid_at=CASE WHEN ${remaining}=0 THEN paid_at ELSE NULL END,version=version+1,updated_at=NOW() WHERE id=${input.orderId}`;
    if (source.check_id) await sql`UPDATE ordering_checks SET paid_cents=GREATEST(0,paid_cents-${amount}),amount_due_cents=LEAST(total_cents,amount_due_cents+${amount}),status=CASE WHEN paid_cents-${amount}<=0 THEN 'open' WHEN amount_due_cents+${amount}>0 THEN 'partially_paid' ELSE 'paid' END,updated_at=NOW() WHERE id=${source.check_id}`;
    const version = Number(order.version)+1;
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) VALUES(${randomUUID()},${input.orderId},${version},'payment_reversed',${input.actor.type},${input.actor.id},${JSON.stringify({transactionId:reversalId,sourceTransactionId:source.id,tenderType:source.tender_type,amountCents:amount,reason:reversalReason,actorName:input.actor.name,actorRole:input.actor.role,totalPaidCents:newPaid,remainingDueCents:remaining})}::jsonb)`;
    return { ...(await checkoutState(input.orderId,input.business,source.check_id)), duplicate: false };
  });
}

export async function reprintPaymentReceipt(input:{orderId:string;business:OrderingBusiness;transactionId:string;reason:string;actor:OrderingActor}){
  const printReason=reason(input.reason,"reprint");
  await ensureOrderingAccountSchema();
  return withTransaction(async()=>{const sql=getSql();const payment=(await sql`SELECT transaction.*,orders.display_number,orders.service_type FROM ordering_payment_transactions transaction JOIN ordering_orders orders ON orders.id=transaction.order_id WHERE transaction.id=${input.transactionId} AND transaction.order_id=${input.orderId} AND transaction.business=${input.business} AND transaction.transaction_type='payment' AND transaction.status='approved'`)[0];if(!payment)throw new PaymentConflictError("Approved payment tender was not found.");const id=randomUUID();await sql`INSERT INTO ordering_print_jobs(id,business,order_id,check_id,payment_transaction_id,purpose,event_subtype,status,is_reprint,actor_type,actor_id,error_message,payload) VALUES(${id},${input.business},${input.orderId},${payment.check_id},${payment.id},'paid_receipt','receipt_reprint','not_configured',TRUE,${input.actor.type},${input.actor.id},'Printer not configured.',${JSON.stringify({heading:'PAYMENT RECEIPT — REPRINT',orderNumber:String(payment.display_number),serviceType:payment.service_type,amountPaidCents:Number(payment.amount_cents),tenderType:payment.tender_type,reprintReason:printReason,cashier:input.actor.name})}::jsonb)`;await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'payment_receipt_reprinted',${input.actor.type},${input.actor.id},${JSON.stringify({printJobId:id,transactionId:payment.id,reason:printReason,actorName:input.actor.name,actorRole:input.actor.role})}::jsonb FROM ordering_orders WHERE id=${input.orderId}`;return {printJobId:id};});
}

export async function printPaidReceipt(input:{orderId:string;business:OrderingBusiness;itemized:boolean;receiptPrinterId?:string;actor:OrderingActor}){
  await ensureOrderingAccountSchema();
  return withTransaction(async()=>{const sql=getSql();const order=(await sql`SELECT * FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`)[0];if(!order)throw new PaymentConflictError("Order was not found.");if(order.payment_status!=="paid")throw new PaymentConflictError("The order must be fully paid before printing its final receipt.");let lines:string[]|undefined;if(input.itemized){const items=await sql`SELECT item.id,item.quantity,item.item_name_snapshot,item.variant_name_snapshot,item.line_total_cents FROM ordering_order_items item WHERE item.order_id=${input.orderId} ORDER BY item.sort_order,item.created_at,item.id`;lines=[];for(const item of items){lines.push(`${item.quantity}x ${item.item_name_snapshot}${item.variant_name_snapshot?` — ${item.variant_name_snapshot}`:""}  $${(Number(item.line_total_cents)/100).toFixed(2)}`);const modifiers=await sql`SELECT option_name_snapshot,quantity FROM ordering_order_item_modifiers WHERE order_item_id=${item.id} ORDER BY print_order_snapshot,created_at,id`;for(const modifier of modifiers)lines.push(`  ${Number(modifier.quantity)>1?`${modifier.quantity}x `:""}${modifier.option_name_snapshot}`);}}const payload={heading:input.itemized?"ITEMIZED PAID RECEIPT":"PAID RECEIPT",orderNumber:String(order.display_number),customerName:`${order.first_name_snapshot||""} ${order.last_name_snapshot||""}`.trim(),serviceType:order.service_type,totalPaidCents:Number(order.paid_cents),remainingDueCents:0,cashier:input.actor.name,receiptPrinterId:input.receiptPrinterId||"",...(lines?{lines}:{})};const pending=(await sql`SELECT id FROM ordering_print_jobs WHERE order_id=${input.orderId} AND purpose='paid_receipt' AND payload->>'customerReceiptPending'='true' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0],id=String(pending?.id||randomUUID());if(pending)await sql`UPDATE ordering_print_jobs SET status='queued',event_subtype=${input.itemized?"pos_itemized":"pos_non_itemized"},error_message='',payload=${JSON.stringify(payload)}::jsonb WHERE id=${id}`;else await sql`INSERT INTO ordering_print_jobs(id,business,order_id,purpose,event_subtype,status,actor_type,actor_id,error_message,payload) VALUES(${id},${input.business},${input.orderId},'paid_receipt',${input.itemized?"pos_itemized":"pos_non_itemized"},'queued',${input.actor.type},${input.actor.id},'',${JSON.stringify(payload)}::jsonb)`;return {printJobId:id};});
}

export async function commitTender(input: {
  orderId: string;
  business: OrderingBusiness;
  tenderType: CheckoutTenderType;
  amountTenderedCents: number;
  clientMutationId: string;
  checkId?: string | null;
  actor: OrderingActor;
  receiptPrinterId?: string;
  cashControlMode?: "till" | "driver_settlement";
  stationKey?: string;
  giftCardNumber?: string;
  giftCardPin?: string;
  providerApproval?: {
    provider: PaymentProviderKey | "test";
    transactionReference: string;
    brand?: string;
    last4?: string;
    details?: Record<string, unknown>;
  };
}) {
  await assertOrderReadyForCheckout(input.orderId, input.business);
  if (input.tenderType === "gift_card") await ensureOrderingGiftCardSchema(); else await ensureOrderingAccountSchema();
  cents(input.amountTenderedCents, "Tender amount");
  if (!input.clientMutationId.trim() || input.clientMutationId.length > 160) throw new PaymentConflictError("A valid payment request ID is required.");

  return withTransaction(async () => {
    const sql = getSql();
    if (input.receiptPrinterId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.receiptPrinterId)) throw new PaymentConflictError("Choose a valid receipt printer / till.");
    const tillCash = input.tenderType === "cash" && input.cashControlMode === "till";
    const receiptPrinters = tillCash || input.receiptPrinterId
      ? await sql`SELECT id FROM ordering_hardware_devices WHERE business=${input.business} AND role='receipt_printer' AND active=TRUE AND adapter_key='network-printer'`
      : [];
    if (receiptPrinters.length && !input.receiptPrinterId) throw new PaymentConflictError("Choose the receipt printer / till for this cash payment.");
    if (input.receiptPrinterId && !receiptPrinters.some((printer) => String(printer.id) === input.receiptPrinterId)) throw new PaymentConflictError("The selected receipt printer / till is not active.");
    const duplicate = await sql`
      SELECT id, order_id, transaction_type FROM ordering_payment_transactions
      WHERE business = ${input.business} AND client_mutation_id = ${input.clientMutationId} LIMIT 1
    `;
    if (duplicate[0]) {
      if (duplicate[0].order_id !== input.orderId || duplicate[0].transaction_type !== "payment") throw new PaymentConflictError("That payment request ID was already used for another operation.");
      return { ...(await checkoutState(input.orderId, input.business, input.checkId)), duplicate: true };
    }

    const rows = await sql`
      SELECT id, customer_id, display_number, status, payment_status, total_cents, paid_cents, amount_due_cents,
             first_name_snapshot, last_name_snapshot, phone_snapshot, service_type
      FROM ordering_orders
      WHERE id = ${input.orderId} AND business = ${input.business}
      FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new PaymentConflictError("Order was not found.");
    const check = input.checkId ? (await sql`SELECT id,total_cents,paid_cents,amount_due_cents FROM ordering_checks WHERE id=${input.checkId} AND order_id=${input.orderId} FOR UPDATE`)[0] : null;
    if (input.checkId && !check) throw new PaymentConflictError("Check was not found.");
    const due = Number(check?.amount_due_cents ?? order.amount_due_cents);
    if (due <= 0) throw new PaymentConflictError("This order has no remaining balance.");

    let applied = Math.min(due, input.amountTenderedCents);
    const change = input.tenderType === "cash" ? Math.max(0, input.amountTenderedCents - applied) : 0;
    if (input.tenderType === "card" && input.amountTenderedCents > due) {
      throw new PaymentConflictError("Credit tender cannot exceed the remaining balance.");
    }
    if (input.tenderType === "card" && !input.providerApproval) {
      throw new PaymentConflictError("Credit payments must be approved by the active payment provider before they are recorded.");
    }
    const transactionId = randomUUID();
    await sql`
      INSERT INTO ordering_payment_transactions (
        id, business, order_id, check_id, customer_id, tender_type, transaction_type, status,
        amount_cents, amount_tendered_cents, change_due_cents, provider, provider_transaction_reference, brand, last4,
        client_mutation_id, created_by, approved_at, details
      ) VALUES (
        ${transactionId}, ${input.business}, ${input.orderId}, ${input.checkId || null}, ${order.customer_id || null}, ${input.tenderType},
        'payment', 'approved', ${applied}, ${input.amountTenderedCents}, ${change},
        ${input.providerApproval?.provider || (input.tenderType === "gift_card" ? "corner_ops_gift_card" : "")},
        ${input.providerApproval?.transactionReference || ""}, ${input.providerApproval?.brand || ""}, ${input.providerApproval?.last4 || ""}, ${input.clientMutationId},
        ${input.actor.id}, NOW(),
        CAST(${JSON.stringify({ actorName: input.actor.name, actorType: input.actor.type, giftCard: input.tenderType === "gift_card", receiptPrinterId: input.receiptPrinterId || null, ...(input.providerApproval?.details || {}) })} AS jsonb)
      )
    `;
    if (input.tenderType === "cash" && input.cashControlMode === "till" && input.stationKey?.trim()) {
      const stationKey=input.stationKey.trim().toLowerCase(),station=(await sql`SELECT * FROM ordering_payment_stations WHERE business=${input.business} AND station_key=${stationKey} AND station_mode='payment' AND active=TRUE`)[0];
      if(!station)throw new PaymentConflictError("Cash can only be accepted at the configured payment station.");
      const terminalId=randomUUID();
      const terminal=(await sql`INSERT INTO ordering_pos_terminals(id,business,name,terminal_key,terminal_type,location_label,allow_cash,allow_offline_cash) VALUES(${terminalId},${input.business},${station.name},${station.station_key},'pos',${station.name},TRUE,FALSE) ON CONFLICT(business,terminal_key) DO UPDATE SET name=EXCLUDED.name,active=TRUE,last_seen_at=NOW(),updated_at=NOW() RETURNING id`)[0];
      let register=(await sql`SELECT * FROM ordering_register_sessions WHERE terminal_id=${terminal.id} AND status IN ('open','counting') ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`)[0];
      if(!register){const registerId=randomUUID();register=(await sql`INSERT INTO ordering_register_sessions(id,business,terminal_id,status,opening_cash_cents,expected_cash_cents,opened_by,notes) VALUES(${registerId},${input.business},${terminal.id},'open',0,0,${input.actor.id},'Automatically opened on first cash sale; opening float must be reconciled at close.') RETURNING *`)[0]}
      await sql`INSERT INTO ordering_cash_drawer_movements(id,register_session_id,order_id,payment_transaction_id,movement_type,delta_cash_cents,reason,created_by,details) VALUES(${randomUUID()},${register.id},${input.orderId},${transactionId},'sale',${applied},'Cash sale',${input.actor.id},${JSON.stringify({stationKey,amountTenderedCents:input.amountTenderedCents,changeDueCents:change})}::jsonb)`;
      await sql`UPDATE ordering_register_sessions SET expected_cash_cents=expected_cash_cents+${applied} WHERE id=${register.id}`;
      await sql`UPDATE ordering_payment_transactions SET details=details||${JSON.stringify({stationKey,registerSessionId:register.id})}::jsonb WHERE id=${transactionId}`;
    }
    if (input.tenderType === "gift_card") {
      if (!input.giftCardNumber) throw new PaymentConflictError("Gift card number is required.");
      try {
        const card = await redeemGiftCard({ business: input.business, cardNumber: input.giftCardNumber, pin: input.giftCardPin, amountCents: applied, operationKey: `payment:${input.clientMutationId}`, actor: input.actor, orderId: input.orderId, paymentId: transactionId });
        applied = Math.abs(Number(card.entry.delta_balance_cents));
        await sql`UPDATE ordering_payment_transactions SET amount_cents=${applied},amount_tendered_cents=${applied} WHERE id=${transactionId}`;
      } catch (error) {
        if (error instanceof GiftCardError) throw new PaymentConflictError(error.message);
        throw error;
      }
    }

    if (check) {
      const checkPaid = Number(check.paid_cents) + applied;
      const checkRemaining = Math.max(0, Number(check.total_cents) - checkPaid);
      await sql`UPDATE ordering_checks SET paid_cents=${checkPaid},amount_due_cents=${checkRemaining},status=${checkRemaining === 0 ? "paid" : "partially_paid"},updated_at=NOW() WHERE id=${check.id}`;
    }
    const newPaid = Number(order.paid_cents) + applied;
    const remaining = Math.max(0, Number(order.total_cents) - newPaid);
    const paymentStatus = remaining === 0 ? "paid" : "partially_paid";
    await sql`
      UPDATE ordering_orders
      SET paid_cents = ${newPaid}, amount_due_cents = ${remaining}, payment_status = ${paymentStatus},
          paid_at = CASE WHEN ${remaining} = 0 THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
          paid_by = CASE WHEN ${remaining} = 0 THEN ${input.actor.id} ELSE paid_by END,
          version = version + 1, updated_at = NOW()
      WHERE id = ${input.orderId}
    `;
    if (remaining === 0) await completePaidPaymentQueue(input.business,input.orderId,input.checkId);
    await sql`
      INSERT INTO ordering_order_events (id, order_id, order_version, event_type, actor_type, actor_id, details)
      SELECT ${randomUUID()}, id, version, 'payment_recorded', ${input.actor.type}, ${input.actor.id},
             CAST(${JSON.stringify({ transactionId, tenderType: input.tenderType, amountCents: applied, amountTenderedCents: input.amountTenderedCents, changeDueCents: change, remainingDueCents: remaining })} AS jsonb)
      FROM ordering_orders WHERE id = ${input.orderId}
    `;

    const alreadySent = order.status !== "draft" && order.status !== "confirmed";
    const purpose = alreadySent ? "payment_update" : "paid_receipt";
    await sql`
      INSERT INTO ordering_print_jobs (
        id, business, order_id, check_id, payment_transaction_id, purpose, event_subtype, status,
        actor_type, actor_id, error_message, payload
      ) VALUES (
        ${randomUUID()}, ${input.business}, ${input.orderId}, ${input.checkId || null}, ${transactionId}, ${purpose},
        ${alreadySent ? "payment" : paymentStatus}, 'not_configured', ${input.actor.type}, ${input.actor.id},
        'Printer not configured.',
        CAST(${JSON.stringify({
          heading: alreadySent ? "PAYMENT UPDATE" : remaining === 0 ? "PAID" : "PAYMENT RECEIPT",
          orderNumber: String(order.display_number), customerName: `${order.first_name_snapshot || ""} ${order.last_name_snapshot || ""}`.trim(),
          serviceType: order.service_type, phone: order.phone_snapshot || "", paidThisUpdateCents: applied,
          totalPaidCents: newPaid, remainingDueCents: remaining, paid: remaining === 0,
          cashier: input.actor.name,
          receiptPrinterId: input.receiptPrinterId || "",
          openCashDrawer: tillCash,
          changeDueCents: change,
          customerReceiptPending: input.business === "Corner Deli" && purpose === "paid_receipt",
        })} AS jsonb)
      )
    `;
    return { ...(await checkoutState(input.orderId, input.business, input.checkId)), duplicate: false };
  });
}
