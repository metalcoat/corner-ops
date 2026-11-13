import { getSql, withTransaction } from "@/lib/db";
import { submitDraftOrder, syncDraftTotals } from "@/lib/ordering-order-lifecycle";
import { PaymentConflictError } from "@/lib/ordering-payments";
import type { OrderingActor } from "@/lib/ordering-route-auth";

/** A fully covered reward order needs a kitchen submission, but no card charge. */
export async function submitZeroBalanceCustomerOrder(orderId: string, actor: OrderingActor) {
  return withTransaction(async () => {
    const sql = getSql();
    const current = (await sql`SELECT status,source FROM ordering_orders WHERE id=${orderId} AND business='Corner Deli' FOR UPDATE`)[0];
    if (!current || current.source !== "web") throw new PaymentConflictError("Online order was not found.");
    await syncDraftTotals(orderId, "Corner Deli");
    const balance = (await sql`SELECT total_cents,amount_due_cents FROM ordering_orders WHERE id=${orderId}`)[0];
    if (Number(balance.total_cents) !== 0 || Number(balance.amount_due_cents) !== 0)
      throw new PaymentConflictError("The order total changed. Review the total before paying.");
    const submitted = await submitDraftOrder(orderId, "Corner Deli", actor);
    if (Number(submitted.order.total_cents) !== 0 || Number(submitted.order.amount_due_cents) !== 0)
      throw new PaymentConflictError("The order total changed. Review the total before paying.");
    const order = (await sql`UPDATE ordering_orders SET payment_status='paid',paid_at=COALESCE(paid_at,NOW()),paid_by=${actor.id},updated_at=NOW() WHERE id=${orderId} RETURNING *`)[0];
    return { ...submitted, order };
  });
}
