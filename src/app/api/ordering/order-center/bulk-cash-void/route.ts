import { createHash, randomUUID } from "node:crypto";
import { apiError } from "@/lib/http";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { isAuthorizationResponse, orderingManagerActor } from "@/lib/ordering-route-auth";
import { voidSentOrder } from "@/lib/ordering-voids";
import { reverseTender } from "@/lib/ordering-payments";
import { cancelPaymentQueueEntries } from "@/lib/ordering-payment-stations";

export const runtime = "nodejs";
const BUSINESS = "Corner Deli";
const MAX_ORDERS = 500;

class BulkVoidInputError extends Error {}

function dates(from: unknown, to: unknown) {
  const valid = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to)) throw new BulkVoidInputError("Choose valid start and end paid dates.");
  const start = String(from), end = String(to);
  const days = (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000;
  if (days < 0 || days > 366) throw new BulkVoidInputError("Choose a date range of up to 366 days, with the start before the end.");
  return { from: start, to: end };
}

async function candidates(from: string, to: string, orderId?: string) {
  await ensureOrderingAccountSchema();
  const rows = await getSql()`
    SELECT o.id, o.display_number, o.version, o.total_cents, o.paid_cents,
      o.first_name_snapshot, o.last_name_snapshot,
      COALESCE(o.paid_at, pay.last_cash_at) AS paid_at
    FROM ordering_orders o
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE p.transaction_type='payment' AND p.status='approved' AND p.tender_type='cash') AS cash_count,
        COUNT(*) FILTER (WHERE p.transaction_type='payment' AND p.status='approved' AND p.tender_type <> 'cash') AS other_count,
        COALESCE(SUM(CASE
          WHEN p.status='approved' AND p.tender_type='cash' AND p.transaction_type='payment' THEN p.amount_cents
          WHEN p.status='approved' AND p.tender_type='cash' AND p.transaction_type IN ('void','refund') THEN -p.amount_cents
          ELSE 0 END),0) AS cash_net_cents,
        MAX(COALESCE(p.approved_at,p.created_at)) FILTER (WHERE p.transaction_type='payment' AND p.status='approved' AND p.tender_type='cash') AS last_cash_at
      FROM ordering_payment_transactions p WHERE p.order_id=o.id AND p.business=o.business
    ) pay
    WHERE o.business=${BUSINESS}
      AND (${orderId ?? null}::uuid IS NULL OR o.id=${orderId ?? null}::uuid)
      AND o.status IN ('draft','sent_to_kitchen','in_progress','ready','completed')
      AND o.voided_at IS NULL AND o.payment_status='paid'
      AND o.total_cents > 0 AND o.paid_cents=o.total_cents AND o.amount_due_cents=0
      AND pay.cash_count > 0 AND pay.other_count=0 AND pay.cash_net_cents=o.paid_cents
      AND (COALESCE(o.paid_at,pay.last_cash_at) AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date
    ORDER BY paid_at, o.id LIMIT ${MAX_ORDERS + 1}
  `;
  if (rows.length > MAX_ORDERS) throw new BulkVoidInputError("More than 500 cash orders match. Narrow the paid-date range.");
  return rows.map(row => ({
    id: String(row.id), displayNumber: String(row.display_number), version: Number(row.version),
    amountCents: Number(row.paid_cents), paidAt: new Date(row.paid_at).toISOString(),
    customerName: `${row.first_name_snapshot || ""} ${row.last_name_snapshot || ""}`.trim(),
  }));
}

function snapshot(from: string, to: string, orders: Awaited<ReturnType<typeof candidates>>) {
  return createHash("sha256").update(JSON.stringify({ from, to, orders })).digest("hex");
}

function errorResponse(error: unknown) {
  if (error instanceof BulkVoidInputError) return Response.json({ error: error.message }, { status: 400 });
  console.error("[bulk-cash-void] failed", error);
  return apiError(error);
}

export async function GET(request: Request) {
  if (process.env.LOCAL_DEVELOPMENT !== "true") return Response.json({ error: "Unavailable." }, { status: 404 });
  const actor = await orderingManagerActor(BUSINESS);
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const params = new URL(request.url).searchParams;
    const { from, to } = dates(params.get("from"), params.get("to"));
    const orders = await candidates(from, to);
    return Response.json({ from, to, orders, count: orders.length, totalCents: orders.reduce((sum, order) => sum + order.amountCents, 0), previewToken: snapshot(from, to, orders) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  if (process.env.LOCAL_DEVELOPMENT !== "true") return Response.json({ error: "Unavailable." }, { status: 404 });
  const actor = await orderingManagerActor(BUSINESS);
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const body = await request.json();
    const { from, to } = dates(body.from, body.to);
    const reason = String(body.reason || "").trim();
    if (reason.length < 3 || reason.length > 300) throw new BulkVoidInputError("Enter a reason between 3 and 300 characters.");
    const orders = await candidates(from, to);
    if (!orders.length) throw new BulkVoidInputError("No eligible cash orders remain. Preview again.");
    if (body.previewToken !== snapshot(from, to, orders)) throw new BulkVoidInputError("The matching orders changed. Preview again before voiding.");
    if (body.confirmation !== `VOID ${orders.length} CASH ORDERS`) throw new BulkVoidInputError(`Type VOID ${orders.length} CASH ORDERS to confirm.`);
    const batchId = randomUUID();
    const auditReason = `Dev bulk cash void ${batchId}: ${reason}`;
    const skipped: Array<{ displayNumber: string; reason: string }> = [];
    let voided = 0;
    let reversedCents = 0;
    for (const previewOrder of orders) {
      try {
        await withTransaction(async () => {
          const sql = getSql();
          await sql`SELECT id FROM ordering_orders WHERE id=${previewOrder.id} FOR UPDATE`;
          const current = (await candidates(from, to, previewOrder.id))[0];
          if (!current || current.version !== previewOrder.version || current.amountCents !== previewOrder.amountCents) throw new BulkVoidInputError("Order changed since preview.");
          const payments = await sql`
            SELECT p.id, p.amount_cents - COALESCE(SUM(r.amount_cents) FILTER (WHERE r.status='approved' AND r.transaction_type IN ('void','refund')),0) AS remaining_cents
            FROM ordering_payment_transactions p
            LEFT JOIN ordering_payment_transactions r ON r.related_transaction_id=p.id
            WHERE p.order_id=${previewOrder.id} AND p.business=${BUSINESS} AND p.transaction_type='payment' AND p.status='approved' AND p.tender_type='cash'
            GROUP BY p.id ORDER BY p.id
          `;
          if (payments.reduce((sum, payment) => sum + Number(payment.remaining_cents), 0) !== previewOrder.amountCents) throw new BulkVoidInputError("Cash payment balance changed since preview.");
          await voidSentOrder({ orderId: previewOrder.id, business: BUSINESS, reason: auditReason, actor });
          for (const payment of payments) {
            const amountCents = Number(payment.remaining_cents);
            if (amountCents <= 0) continue;
            await reverseTender({ orderId: previewOrder.id, business: BUSINESS, transactionId: String(payment.id), amountCents, clientMutationId: `bulk-cash-void:${batchId}:${payment.id}`, reason: auditReason, actor });
          }
          await cancelPaymentQueueEntries(BUSINESS, previewOrder.id);
        });
        voided += 1;
        reversedCents += previewOrder.amountCents;
      } catch (error) {
        skipped.push({ displayNumber: previewOrder.displayNumber, reason: error instanceof Error ? error.message : "Could not void order." });
      }
    }
    return Response.json({ batchId, voided, reversedCents, skipped });
  } catch (error) { return errorResponse(error); }
}
