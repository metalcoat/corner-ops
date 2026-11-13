import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { cancelOrderItem, ItemCancellationError, lineWasSent } from "@/lib/ordering-item-cancellations";
import { appendConfiguredOrderItemsWithVariants, type VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import { assignNewItemsToPrimaryCheck } from "@/lib/ordering-checks";
import { orderOpenForChanges } from "@/lib/ordering-fulfillment-change";
import { describeSnapshot, lineSnapshot, sameLine, type LineSnapshot } from "@/lib/ordering-line-edit-rules";
import { loadSavedLine } from "@/lib/ordering-sent-lines";

export class OrderLineEditError extends Error {}

/**
 * EDIT on a saved line: the old line comes off (same bookkeeping as a void) and the new one takes its
 * place, priced from the menu now. A line the kitchen has needs a manager and a reason; the kitchen
 * gets a CHANGED ticket for it on the next Send or payment (runDraftSubmit), not a void plus a new item.
 */
export async function editOrderLine(input: { orderId: string; itemId: string; item: VariantConfiguredOrderItemInput; reason: string; clientMutationId: string; actor: OrderingActor; approver?: OrderingActor }) {
  const quantity = Number(input.item.quantity ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new OrderLineEditError("Choose a quantity from 1 to 99.");
  if (!input.clientMutationId || input.clientMutationId.length > 120) throw new OrderLineEditError("A valid edit request ID is required.");
  const reason = input.reason.trim();
  if (reason.length > 500) throw new OrderLineEditError("The reason must be 500 characters or fewer.");
  await ensureOrderingAccountSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const order = (await sql`SELECT * FROM ordering_orders WHERE id=${input.orderId} AND business='Corner Deli' FOR UPDATE`)[0];
    if (!order) throw new OrderLineEditError("Order was not found.");
    const duplicate = (await sql`SELECT details FROM ordering_order_events WHERE order_id=${input.orderId} AND event_type='order_item_edited' AND details->>'clientMutationId'=${input.clientMutationId}`)[0];
    if (duplicate) return { duplicate: true, newItemId: String(duplicate.details.newItemId), sent: Boolean(duplicate.details.rootSent) };
    if (!await orderOpenForChanges(input.orderId, order)) throw new OrderLineEditError("This order is not open for changes. Load it on the POS first.");
    const old = await loadSavedLine(input.itemId);
    if (old.order_id !== input.orderId) throw new OrderLineEditError("Order item was not found.");
    if (old.custom_item) throw new OrderLineEditError("A custom item can't be edited. Void it and add it again.");
    if (String(old.item_id) !== input.item.itemId) throw new OrderLineEditError("An edit keeps the same menu item. To swap items, void this one and add the other.");
    const remaining = Number(old.quantity) - Number(old.cancelled_quantity || 0);
    if (remaining < 1) throw new OrderLineEditError("This item was already voided.");
    const sent = await lineWasSent(order, input.itemId);
    const manager = input.approver || input.actor;
    if (sent && !canManagePos(manager)) throw new OrderLineEditError("Manager authorization is required: enter a manager PIN to change an item the kitchen already has.");
    if (sent && reason.length < 3) throw new OrderLineEditError("A reason is required to change an item the kitchen already has.");
    // Edited again before Send: the kitchen still only knows the first version, so compare against that.
    const reopenAt = order.submitted_at ? (await sql`SELECT created_at FROM ordering_order_events WHERE order_id=${input.orderId} AND event_type='order_reopened_for_additions' ORDER BY created_at DESC LIMIT 1`)[0]?.created_at : null;
    const earlier = reopenAt ? (await sql`SELECT details FROM ordering_order_events WHERE order_id=${input.orderId} AND event_type='order_item_edited' AND details->>'newItemId'=${input.itemId} AND created_at>=${reopenAt} ORDER BY created_at DESC LIMIT 1`)[0]?.details : null;
    const before: LineSnapshot = earlier ? earlier.before : lineSnapshot(old);
    const rootItemId = earlier ? String(earlier.rootItemId) : input.itemId;
    const rootSent = earlier ? Boolean(earlier.rootSent) : sent;
    const editReason = reason || "Changed before it was sent";
    const priceBeforeCents = Math.round(Number(old.line_total_cents) * remaining / Number(old.quantity));
    try {
      await cancelOrderItem({ orderId: input.orderId, itemId: input.itemId, quantity: remaining, reason: `Edited: ${editReason}`.slice(0, 500), refundMethod: "later", clientMutationId: `line-edit:${input.clientMutationId}`, actor: input.actor, approver: input.approver, via: "line_edit" });
    } catch (error) {
      if (error instanceof ItemCancellationError) throw new OrderLineEditError(error.message);
      throw error;
    }
    let newItemId: string;
    try {
      [newItemId] = await appendConfiguredOrderItemsWithVariants(input.orderId, "Corner Deli", [{ ...input.item, quantity }]);
    } catch (error) {
      throw new OrderLineEditError(error instanceof Error ? error.message : "The changed item could not be priced.");
    }
    // The new version sits where the old one was on the order and the ticket.
    await sql`UPDATE ordering_order_items SET sort_order=${old.sort_order},added_by=${input.actor.id},added_by_name=${input.actor.name} WHERE id=${newItemId}`;
    await assignNewItemsToPrimaryCheck(input.orderId, [newItemId]);
    const added = await loadSavedLine(newItemId);
    const after = lineSnapshot(added);
    if (sameLine(lineSnapshot(old), after)) throw new OrderLineEditError("Nothing changed on this item.");
    const updated = (await sql`SELECT version,total_cents,paid_cents,amount_due_cents,payment_status FROM ordering_orders WHERE id=${input.orderId}`)[0];
    if (Number(updated.paid_cents) > Number(updated.total_cents))
      throw new OrderLineEditError("This change makes the order cost less than what was already paid. Use VOID on the item to refund the difference instead.");
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) VALUES(${randomUUID()},${input.orderId},${updated.version},'order_item_edited',${input.actor.type},${input.actor.id},${JSON.stringify({
      clientMutationId: input.clientMutationId, oldItemId: input.itemId, newItemId, rootItemId, rootSent, sent, itemName: old.item_name_snapshot,
      before, after, beforeText: describeSnapshot(before), afterText: describeSnapshot(after), priceBeforeCents, priceAfterCents: Number(added.line_total_cents),
      reason: editReason, actorName: input.actor.name, actorRole: input.actor.role, approvedById: input.approver?.id || null, approvedByName: input.approver?.name || null,
    })}::jsonb)`;
    return { ok: true, newItemId, sent: rootSent, totalCents: Number(updated.total_cents), amountDueCents: Number(updated.amount_due_cents), paymentStatus: String(updated.payment_status) };
  });
}
