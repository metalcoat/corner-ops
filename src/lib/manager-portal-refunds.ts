// Refunds and voids from the manager portal (/employee/manager/orders), away from the POS.
//
// Same money paths as the POS: reverseTender (card back through MX, cash out of the
// drawer, gift card / account credit back), settleTenderAsStoreCredit, item
// cancellations and voidSentOrder. Only managers and owners, signed in to the
// employee app, and each action confirmed with their own PIN because a phone
// stays signed in for two weeks. Everything is tagged via "manager_portal" so the
// order's trail says where it was done.
import { getEmployeeSession } from "@/lib/employee-auth";
import { getSql } from "@/lib/db";
import { managerApprovalFromPin } from "@/lib/pos-auth";
import { PaymentConflictError, reverseTender, settleTenderAsStoreCredit } from "@/lib/ordering-payments";
import { cashRefundBecomesCredit } from "@/lib/ordering-refund-policy";
import { cancelOrderItem, quoteItemCancellation } from "@/lib/ordering-item-cancellations";
import { voidSentOrder } from "@/lib/ordering-voids";
import type { OrderingActor } from "@/lib/ordering-route-auth";

const BUSINESS = "Corner Deli";
export const PORTAL_VIA = "manager_portal";

export class PortalMoneyError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export type RefundMethod = "original" | "store_credit";
export type RefundableTender = { id: string; tenderType: string; label: string; remainingCents: number };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const UUID = /^[0-9a-f-]{36}$/i;

/** The signed-in manager or owner, confirmed by their own PIN (no PIN: looking only, e.g. a refund quote). */
export async function portalManager(pin: unknown, attemptKeys: { ipKey: string; businessKey: string } | null): Promise<OrderingActor> {
  const session = await getEmployeeSession();
  if (!session || session.business !== BUSINESS || (session.posRole !== "manager" && session.posRole !== "owner")) throw new PortalMoneyError("Manager access required.", 403);
  if (!attemptKeys) return { id: session.employeeId, email: session.employeeId, name: session.name, type: "employee", role: session.posRole };
  if (!String(pin || "").trim()) throw new PortalMoneyError("Enter your PIN to confirm.", 403);
  let approver;
  try { approver = await managerApprovalFromPin(pin, attemptKeys); }
  catch (error) { throw new PortalMoneyError(error instanceof Error ? error.message : "PIN not accepted.", 403); }
  if (approver.id !== session.employeeId) throw new PortalMoneyError("Enter your own PIN.", 403);
  return { id: session.employeeId, email: session.employeeId, name: session.name, type: "employee", role: session.posRole };
}

/** Approved payments on the order with what's left to give back on each. */
export async function refundableTenders(orderId: string): Promise<RefundableTender[]> {
  const rows = await getSql()`
    SELECT p.id, p.tender_type, COALESCE(p.brand,'') brand, COALESCE(p.last4,'') last4,
      p.amount_cents - COALESCE((SELECT SUM(r.amount_cents) FROM ordering_payment_transactions r
        WHERE r.related_transaction_id=p.id AND r.transaction_type IN ('void','refund') AND r.status='approved'),0) remaining_cents
    FROM ordering_payment_transactions p
    WHERE p.order_id=${orderId} AND p.business=${BUSINESS} AND p.transaction_type='payment' AND p.status='approved'
    ORDER BY p.created_at`;
  return rows.filter((row) => Number(row.remaining_cents) > 0).map((row) => ({
    id: String(row.id), tenderType: String(row.tender_type), remainingCents: Number(row.remaining_cents),
    label: row.last4 ? `${row.brand || "Card"} ····${row.last4}` : String(row.tender_type).replaceAll("_", " "),
  }));
}

async function orderFor(orderId: string) {
  if (!UUID.test(orderId)) throw new PortalMoneyError("Order not found.", 404);
  const order = (await getSql()`SELECT id,status,paid_cents,customer_id,voided_at FROM ordering_orders WHERE id=${orderId} AND business=${BUSINESS}`)[0];
  if (!order) throw new PortalMoneyError("Order not found.", 404);
  return order;
}

function reasonOf(value: unknown) {
  const reason = String(value || "").trim();
  if (reason.length < 3) throw new PortalMoneyError("Enter a reason of at least three characters.", 400);
  return reason.slice(0, 500);
}

/** Store credit when asked for, and always for part of a cash order with a customer on it (owner rule). */
function leavesCredit(method: RefundMethod, tender: RefundableTender, wholeOrder: boolean, customerId: unknown) {
  return method === "store_credit" || cashRefundBecomesCredit({ tenderType: tender.tenderType, wholeOrder, customerId: customerId ? String(customerId) : null });
}

/** Gives back an amount from one payment: to the card/cash/gift card it came from, or as store credit. */
export async function portalRefundAmount(input: { orderId: string; transactionId: string; amountCents: number; method: RefundMethod; reason: unknown; clientMutationId: string; actor: OrderingActor }) {
  const order = await orderFor(input.orderId);
  if (order.status === "draft" && !order.voided_at) throw new PortalMoneyError("This order is still open at the POS. Refund it there.");
  const reason = reasonOf(input.reason);
  const tender = (await refundableTenders(input.orderId)).find((row) => row.id === input.transactionId);
  if (!tender) throw new PortalMoneyError("Choose one of this order's payments.");
  const amount = Math.round(Number(input.amountCents));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PortalMoneyError("Enter an amount.", 400);
  if (amount > tender.remainingCents) throw new PortalMoneyError(`At most ${dollars(tender.remainingCents)} can come off this payment.`);
  const credit = leavesCredit(input.method, tender, amount >= Number(order.paid_cents), order.customer_id);
  if (credit) {
    if (!order.customer_id) throw new PortalMoneyError("This order has no customer on it, so store credit has nowhere to go.");
    await settleTenderAsStoreCredit({ orderId: input.orderId, transactionId: tender.id, refundCents: amount, creditCents: amount, clientMutationId: input.clientMutationId, reason, actor: input.actor, moneyBack: true, via: PORTAL_VIA });
  } else {
    await reverseTender({ orderId: input.orderId, business: BUSINESS, transactionId: tender.id, amountCents: amount, clientMutationId: input.clientMutationId, reason, actor: input.actor, moneyBack: true, via: PORTAL_VIA });
  }
  return { amountCents: amount, method: credit ? "store credit" : tender.label, forcedCredit: credit && input.method !== "store_credit" };
}

/** What voiding some of an item would take off the order and give back. */
export async function portalQuoteItem(input: { orderId: string; itemId: string; quantity: number; actor: OrderingActor }) {
  await orderFor(input.orderId);
  return quoteItemCancellation(input);
}

/** Voids some or all of one item and gives its share back to a payment (or as store credit). */
export async function portalRefundItem(input: { orderId: string; itemId: string; quantity: number; transactionId?: string; method: RefundMethod; reason: unknown; clientMutationId: string; actor: OrderingActor }) {
  const order = await orderFor(input.orderId);
  const reason = reasonOf(input.reason);
  const quote = await quoteItemCancellation(input);
  let tender: RefundableTender | undefined;
  if (quote.refundRequiredCents > 0) {
    const tenders = await refundableTenders(input.orderId);
    tender = input.transactionId ? tenders.find((row) => row.id === input.transactionId) : tenders.find((row) => row.remainingCents >= quote.refundRequiredCents);
    if (!tender) throw new PortalMoneyError("Choose a payment with enough left on it for this refund.");
    if (tender.remainingCents < quote.refundRequiredCents) throw new PortalMoneyError(`That payment only has ${dollars(tender.remainingCents)} left.`);
    if (input.method === "store_credit" && !order.customer_id) throw new PortalMoneyError("This order has no customer on it, so store credit has nowhere to go.");
  }
  const credit = Boolean(tender) && leavesCredit(input.method, tender!, quote.refundRequiredCents >= Number(order.paid_cents), order.customer_id);
  await cancelOrderItem({
    orderId: input.orderId, itemId: input.itemId, quantity: input.quantity, reason, paymentTransactionId: tender?.id,
    refundMethod: input.method === "store_credit" ? "store_credit" : "original", storeCreditCents: input.method === "store_credit" ? quote.refundRequiredCents : undefined,
    clientMutationId: input.clientMutationId, actor: input.actor, via: PORTAL_VIA,
  });
  return { itemName: String(quote.itemName), quantity: input.quantity, amountCents: quote.refundRequiredCents, method: !tender ? "" : credit ? "store credit" : tender.label };
}

/**
 * Voids the whole order, then (unless told not to) gives back what was paid on every payment.
 * The void stands even if a refund fails; whatever is left shows under "Needs refund or credit" at the POS.
 */
export async function portalVoidOrder(input: { orderId: string; reason: unknown; refund: RefundMethod | "none"; clientMutationId: string; actor: OrderingActor }) {
  const order = await orderFor(input.orderId);
  if (order.voided_at) throw new PortalMoneyError("This order is already voided.");
  const reason = reasonOf(input.reason);
  await voidSentOrder({ orderId: input.orderId, business: BUSINESS, reason, actor: input.actor, via: PORTAL_VIA });
  const refunds: Array<{ label: string; amountCents: number; ok: boolean; error?: string }> = [];
  if (input.refund !== "none") {
    for (const tender of await refundableTenders(input.orderId)) {
      const clientMutationId = `${input.clientMutationId}:${tender.id}`.slice(0, 160);
      try {
        const credit = input.refund === "store_credit" && tender.tenderType !== "store_credit";
        if (credit) {
          if (!order.customer_id) throw new PaymentConflictError("No customer on the order for store credit.");
          await settleTenderAsStoreCredit({ orderId: input.orderId, transactionId: tender.id, refundCents: tender.remainingCents, creditCents: tender.remainingCents, clientMutationId, reason, actor: input.actor, moneyBack: true, via: PORTAL_VIA });
        } else {
          await reverseTender({ orderId: input.orderId, business: BUSINESS, transactionId: tender.id, amountCents: tender.remainingCents, clientMutationId, reason, actor: input.actor, moneyBack: true, via: PORTAL_VIA });
        }
        refunds.push({ label: credit ? `${tender.label} → store credit` : tender.label, amountCents: tender.remainingCents, ok: true });
      } catch (error) {
        refunds.push({ label: tender.label, amountCents: tender.remainingCents, ok: false, error: error instanceof Error ? error.message : "Refund failed." });
      }
    }
  }
  return { voided: true, refunds };
}
