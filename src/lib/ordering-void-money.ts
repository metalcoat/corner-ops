// Money left on voided orders and voided items.
//
// Owner rule (2026-10-24): an order (or part of one) can be voided without
// refunding on the spot, but by the end of the business day every dollar the
// customer paid for food they're no longer getting must be refunded or left
// as store credit on their account. "Owed" is what was paid beyond what the
// order now costs (a voided order costs nothing). Managers resolve it from the
// Order Center; at closing, owners get one email listing anything left.
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { PaymentConflictError, reverseTender, settleTenderAsStoreCredit } from "@/lib/ordering-payments";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { ownerNotificationEmails, sendTransactionalEmail } from "@/lib/transactional-email";

export type VoidMoneyOrder = {
  orderId: string;
  displayNumber: string;
  customerName: string;
  customerId: string | null;
  status: string;
  owedCents: number;
  voidedAt: string | null;
  tenders: Array<{ id: string; tenderType: string; brand: string; last4: string; remainingCents: number }>;
};

/** Orders (last 90 days) still holding money for voided food; one order when orderId is given. */
export async function listUnresolvedVoidMoney(business: OrderingBusiness, orderId?: string): Promise<VoidMoneyOrder[]> {
  const sql = getSql();
  const orders = await sql`
    SELECT o.id, o.display_number, o.status, o.customer_id, o.voided_at, o.updated_at,
           COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name,
           (o.paid_cents - CASE WHEN o.status='cancelled' THEN 0 ELSE o.total_cents END) owed_cents
    FROM ordering_orders o
    WHERE o.business=${business} AND o.status<>'draft' AND o.created_at>NOW()-INTERVAL '90 days'
      AND (${orderId ?? null}::uuid IS NULL OR o.id=${orderId ?? null}::uuid)
      AND (o.status='cancelled' OR EXISTS(SELECT 1 FROM ordering_order_item_cancellations c WHERE c.order_id=o.id))
      AND o.paid_cents - CASE WHEN o.status='cancelled' THEN 0 ELSE o.total_cents END > 0
    ORDER BY COALESCE(o.voided_at, o.updated_at)`;
  const result: VoidMoneyOrder[] = [];
  for (const order of orders) {
    const tenders = await sql`
      SELECT p.id, p.tender_type, COALESCE(p.brand,'') brand, COALESCE(p.last4,'') last4,
             p.amount_cents - COALESCE((SELECT SUM(r.amount_cents) FROM ordering_payment_transactions r
               WHERE r.related_transaction_id=p.id AND r.transaction_type IN ('void','refund') AND r.status='approved'),0) remaining_cents
      FROM ordering_payment_transactions p
      WHERE p.order_id=${order.id} AND p.transaction_type='payment' AND p.status='approved'
      ORDER BY p.created_at`;
    result.push({
      orderId: String(order.id),
      displayNumber: String(order.display_number),
      customerName: String(order.customer_name),
      customerId: order.customer_id ? String(order.customer_id) : null,
      status: String(order.status),
      owedCents: Number(order.owed_cents),
      voidedAt: order.voided_at ? String(order.voided_at) : null,
      tenders: tenders.filter((row) => Number(row.remaining_cents) > 0).map((row) => ({
        id: String(row.id), tenderType: String(row.tender_type), brand: String(row.brand), last4: String(row.last4), remainingCents: Number(row.remaining_cents),
      })),
    });
  }
  return result;
}

/** Refunds (to the original payment) or leaves store credit for money owed on a voided order. */
export async function resolveVoidMoney(input: {
  business: OrderingBusiness;
  orderId: string;
  transactionId: string;
  amountCents: number;
  method: "refund" | "store_credit";
  reason: string;
  clientMutationId: string;
  actor: OrderingActor;
}) {
  if (!canManagePos(input.actor)) throw new PaymentConflictError("A manager or owner has to refund or credit voided money.");
  if (!/^[0-9a-f-]{36}$/i.test(input.orderId)) throw new PaymentConflictError("This order has nothing left to refund or credit.");
  // One resolution per order at a time: lock the order, then re-read what's owed, so two
  // managers (or two payments on one order) can never give back more than is owed.
  await withTransaction(async () => {
    await getSql()`SELECT id FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`;
    const owed = (await listUnresolvedVoidMoney(input.business, input.orderId))[0];
    if (!owed) throw new PaymentConflictError("This order has nothing left to refund or credit.");
    const tender = owed.tenders.find((row) => row.id === input.transactionId);
    if (!tender) throw new PaymentConflictError("Choose one of this order's payments.");
    const amount = Math.trunc(Number(input.amountCents));
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentConflictError("Enter an amount.");
    if (amount > owed.owedCents || amount > tender.remainingCents) throw new PaymentConflictError(`At most ${(Math.min(owed.owedCents, tender.remainingCents) / 100).toFixed(2)} can come off this payment.`);
    const reason = input.reason.trim().length >= 3 ? input.reason.trim() : input.method === "refund" ? "Voided food refunded" : "Voided food left as store credit";
    if (input.method === "store_credit") {
      if (!owed.customerId) throw new PaymentConflictError("Attach a customer to this order before leaving store credit.");
      await settleTenderAsStoreCredit({ orderId: input.orderId, transactionId: input.transactionId, refundCents: amount, creditCents: amount, clientMutationId: input.clientMutationId, reason, actor: input.actor });
    } else {
      await reverseTender({ orderId: input.orderId, business: input.business, transactionId: input.transactionId, amountCents: amount, clientMutationId: input.clientMutationId, reason, actor: input.actor });
    }
  });
  return listUnresolvedVoidMoney(input.business);
}

function storeParts(at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday)), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * After today's closing time (latest ordering window), emails owners once a day
 * when voided money is still unresolved. Runs from ordering maintenance.
 */
export async function remindUnresolvedVoidMoney(business: OrderingBusiness, now = new Date(), send: typeof sendTransactionalEmail = sendTransactionalEmail) {
  // Only production emails owners; dev and staging hold test orders (the list still shows in the POS).
  if (send === sendTransactionalEmail && process.env.APP_ENV?.trim().toLowerCase() !== "production") return { sent: false, reason: "not_production" };
  const sql = getSql();
  const today = storeParts(now);
  const close = (await sql`
    SELECT MAX(EXTRACT(HOUR FROM closes_at)*60 + EXTRACT(MINUTE FROM closes_at))::int close_minute,
           BOOL_OR(closes_at < opens_at) overnight
    FROM ordering_operating_windows WHERE business=${business} AND active AND weekday=${today.weekday}`)[0];
  if (close?.close_minute == null || close.overnight) return { sent: false, reason: "no_close_time" };
  if (today.minute < Number(close.close_minute) + 15) return { sent: false, reason: "before_close" };
  const key = `void-money-reminder:${business}:${today.date}`;
  if ((await sql`SELECT 1 FROM ordering_operations_audit WHERE action='void_money_reminder' AND target_id=${key} LIMIT 1`)[0]) return { sent: false, reason: "already_sent" };
  // After a failed send, try again every 30 minutes rather than every maintenance tick.
  if ((await sql`SELECT 1 FROM ordering_operations_audit WHERE action='void_money_reminder_failed' AND target_id=${key} AND created_at>NOW()-INTERVAL '30 minutes' LIMIT 1`)[0]) return { sent: false, reason: "retry_later" };
  const owed = await listUnresolvedVoidMoney(business);
  const record = (action: string, details: Record<string, unknown>) => sql`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details)
    VALUES(gen_random_uuid(),${business},'system','system',${action},'business_day',${key},'End-of-day voided money check',${JSON.stringify(details)}::jsonb)`;
  const summary = { orders: owed.length, owedCents: owed.reduce((sum, row) => sum + row.owedCents, 0) };
  if (!owed.length) { await record("void_money_reminder", summary); return { sent: false, reason: "nothing_owed" }; }
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const lines = owed.map((row) => `#${row.displayNumber} ${row.customerName}: ${money(row.owedCents)} (${row.status === "cancelled" ? "voided order" : "voided items"})`);
  const delivery = await send({
    to: ownerNotificationEmails(),
    subject: `${business}: ${owed.length} voided order${owed.length === 1 ? "" : "s"} still need a refund or credit`,
    text: [
      `These orders still hold money for voided food (${money(owed.reduce((sum, row) => sum + row.owedCents, 0))} total).`,
      "Refund each one or leave it as store credit from the POS Order Center (Needs refund or credit).",
      "",
      ...lines,
    ].join("\n"),
    idempotencyKey: key,
  });
  // The day counts as reminded only once the email actually went out.
  if (!delivery.sent) { await record("void_money_reminder_failed", { ...summary, failures: delivery.failures }); return { sent: false, reason: "send_failed" }; }
  await record("void_money_reminder", summary);
  return { sent: true, orders: owed.length };
}
