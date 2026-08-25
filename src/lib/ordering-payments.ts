import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { ensureOrderingGiftCardSchema } from "@/lib/ordering-gift-card-schema";
import { GiftCardError, redeemGiftCard } from "@/lib/ordering-gift-cards";
import { canManagePos } from "@/lib/ordering-route-auth";

export type CheckoutTenderType = "cash" | "card" | "gift_card";

export class PaymentConflictError extends Error {}

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PaymentConflictError(`${label} must be a positive amount in cents.`);
  return value;
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
  giftCardNumber?: string;
  giftCardPin?: string;
}) {
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
    const transactionId = randomUUID();
    await sql`
      INSERT INTO ordering_payment_transactions (
        id, business, order_id, check_id, customer_id, tender_type, transaction_type, status,
        amount_cents, amount_tendered_cents, change_due_cents, provider,
        client_mutation_id, created_by, approved_at, details
      ) VALUES (
        ${transactionId}, ${input.business}, ${input.orderId}, ${input.checkId || null}, ${order.customer_id || null}, ${input.tenderType},
        'payment', 'approved', ${applied}, ${input.amountTenderedCents}, ${change},
        ${input.tenderType === "card" ? "manual_placeholder" : input.tenderType === "gift_card" ? "corner_ops_gift_card" : ""}, ${input.clientMutationId},
        ${input.actor.id}, NOW(),
        CAST(${JSON.stringify({ actorName: input.actor.name, actorType: input.actor.type, manualCard: input.tenderType === "card", giftCard: input.tenderType === "gift_card", receiptPrinterId: input.receiptPrinterId || null })} AS jsonb)
      )
    `;
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
        })} AS jsonb)
      )
    `;
    return { ...(await checkoutState(input.orderId, input.business, input.checkId)), duplicate: false };
  });
}
