import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { reverseLoyaltyForOrder } from "@/lib/ordering-loyalty";

export class OrderVoidError extends Error {}

export async function voidSentOrder(input: { orderId: string; business: OrderingBusiness; reason: string; actor: OrderingActor }) {
  if (!canManagePos(input.actor)) throw new OrderVoidError("Manager or owner authorization is required to void a sent order.");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new OrderVoidError("A void reason is required.");
  if (reason.length > 500) throw new OrderVoidError("Void reason must be 500 characters or fewer.");
  await ensureOrderingAccountSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, display_number, status, payment_status, version, voided_at
      FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new OrderVoidError("Order was not found.");
    if (order.voided_at) return { order, alreadyVoided: true };
    if (!['sent_to_kitchen','in_progress','ready','completed'].includes(String(order.status))) {
      throw new OrderVoidError("Only an order already sent to the kitchen can be voided.");
    }
    const updated = await sql`
      UPDATE ordering_orders SET status='cancelled', cancelled_at=NOW(), closed_at=NOW(), voided_at=NOW(),
        voided_by=${input.actor.id}, void_reason=${reason}, pre_void_status=${order.status},
        pre_void_payment_status=${order.payment_status}, version=version+1, updated_at=NOW()
      WHERE id=${input.orderId} AND version=${order.version}
      RETURNING id,display_number,status,payment_status,version,voided_at,voided_by,void_reason,pre_void_status,pre_void_payment_status
    `;
    if (!updated[0]) throw new OrderVoidError("This order changed while the void was being recorded.");
    await reverseLoyaltyForOrder(input.orderId,input.actor,reason);
    await sql`
      INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)
      VALUES(${randomUUID()},${input.orderId},${updated[0].version},'order_voided',${input.actor.type},${input.actor.id},
        CAST(${JSON.stringify({ reason, actorName: input.actor.name, actorRole: input.actor.role, previousFulfillmentStatus: order.status, previousPaymentStatus: order.payment_status, paymentWasNotRefunded: true })} AS jsonb))
    `;
    return { order: updated[0], alreadyVoided: false };
  });
}
