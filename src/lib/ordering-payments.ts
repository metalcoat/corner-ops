import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";

export type CheckoutTenderType = "cash" | "card";

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
    SELECT id, tender_type, status, amount_cents, amount_tendered_cents, change_due_cents,
           brand, last4, created_by, created_at, approved_at
    FROM ordering_payment_transactions
    WHERE order_id = ${orderId} AND business = ${business} AND (${checkId || null}::uuid IS NULL OR check_id=${checkId || null})
    ORDER BY created_at, id
  `;
  const check = checkId ? (await sql`SELECT id,display_sequence,status,total_cents,paid_cents,amount_due_cents FROM ordering_checks WHERE id=${checkId} AND order_id=${orderId}`)[0] : null;
  if (checkId && !check) throw new PaymentConflictError("Check was not found.");
  return { order: orders[0], check, tenders };
}

export async function commitTender(input: {
  orderId: string;
  business: OrderingBusiness;
  tenderType: CheckoutTenderType;
  amountTenderedCents: number;
  clientMutationId: string;
  checkId?: string | null;
  actor: OrderingActor;
}) {
  await ensureOrderingAccountSchema();
  cents(input.amountTenderedCents, "Tender amount");
  if (!input.clientMutationId.trim() || input.clientMutationId.length > 160) throw new PaymentConflictError("A valid payment request ID is required.");

  return withTransaction(async () => {
    const sql = getSql();
    const duplicate = await sql`
      SELECT id FROM ordering_payment_transactions
      WHERE business = ${input.business} AND client_mutation_id = ${input.clientMutationId} LIMIT 1
    `;
    if (duplicate[0]) return { ...(await checkoutState(input.orderId, input.business, input.checkId)), duplicate: true };

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

    const applied = Math.min(due, input.amountTenderedCents);
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
        ${input.tenderType === "card" ? "manual_placeholder" : ""}, ${input.clientMutationId},
        ${input.actor.id}, NOW(),
        CAST(${JSON.stringify({ actorName: input.actor.name, actorType: input.actor.type, manualCard: input.tenderType === "card" })} AS jsonb)
      )
    `;

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
        })} AS jsonb)
      )
    `;
    return { ...(await checkoutState(input.orderId, input.business, input.checkId)), duplicate: false };
  });
}
