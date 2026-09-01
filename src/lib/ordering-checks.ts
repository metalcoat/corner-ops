import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";

export class CheckConflictError extends Error {}

async function refreshCheckTotals(orderId: string) {
  const sql = getSql();
  const items =
    await sql`SELECT id,quantity,line_total_cents FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
  for (const item of items) {
    const assignments = await sql`
      SELECT assignment.check_id,assignment.quantity,checks.display_sequence
      FROM ordering_check_line_assignments assignment JOIN ordering_checks checks ON checks.id=assignment.check_id
      WHERE assignment.order_item_id=${item.id} ORDER BY checks.display_sequence,checks.id
    `;
    const assignedQuantity = assignments.reduce(
      (sum, row) => sum + Number(row.quantity),
      0,
    );
    if (assignedQuantity !== Number(item.quantity))
      throw new CheckConflictError(
        "Check assignments do not match the original order quantity.",
      );
    const unit = Math.floor(
      Number(item.line_total_cents) / Number(item.quantity),
    );
    let remainder = Number(item.line_total_cents) % Number(item.quantity);
    for (const assignment of assignments) {
      const extra = Math.min(remainder, Number(assignment.quantity));
      remainder -= extra;
      await sql`UPDATE ordering_check_line_assignments SET allocated_cents=${unit * Number(assignment.quantity) + extra} WHERE check_id=${assignment.check_id} AND order_item_id=${item.id}`;
    }
  }
  await sql`
    UPDATE ordering_checks checks SET total_cents=totals.total_cents,
      amount_due_cents=GREATEST(0,totals.total_cents-checks.paid_cents),
      status=CASE WHEN checks.paid_cents=0 THEN 'open' WHEN checks.paid_cents>=totals.total_cents THEN 'paid' ELSE 'partially_paid' END,
      updated_at=NOW()
    FROM (SELECT check_id,COALESCE(SUM(allocated_cents),0)::integer total_cents FROM ordering_check_line_assignments GROUP BY check_id) totals
    WHERE checks.id=totals.check_id AND checks.order_id=${orderId}
  `;
}

export async function ensureInitialCheck(
  orderId: string,
  business: OrderingBusiness,
  actor: OrderingActor,
) {
  await ensureOrderingAccountSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const order = (
      await sql`SELECT id,total_cents FROM ordering_orders WHERE id=${orderId} AND business=${business} FOR UPDATE`
    )[0];
    if (!order) throw new CheckConflictError("Order was not found.");
    let check = (
      await sql`SELECT * FROM ordering_checks WHERE order_id=${orderId} ORDER BY display_sequence LIMIT 1`
    )[0];
    if (!check) {
      const id = randomUUID();
      check = (
        await sql`INSERT INTO ordering_checks(id,business,order_id,display_sequence,total_cents,amount_due_cents,created_by) VALUES(${id},${business},${orderId},1,${order.total_cents},${order.total_cents},${actor.id}) RETURNING *`
      )[0];
      await sql`INSERT INTO ordering_check_line_assignments(check_id,order_item_id,quantity,allocated_cents) SELECT ${id},id,quantity,line_total_cents FROM ordering_order_items WHERE order_id=${orderId}`;
    }
    return check;
  });
}

export async function splitCheck(input: {
  orderId: string;
  business: OrderingBusiness;
  fromCheckId: string;
  lines: Array<{ orderItemId: string; quantity: number }>;
  actor: OrderingActor;
}) {
  await ensureInitialCheck(input.orderId, input.business, input.actor);
  if (!input.lines.length)
    throw new CheckConflictError("Select at least one item quantity to split.");
  return withTransaction(async () => {
    const sql = getSql();
    const order = (
      await sql`SELECT id,paid_cents FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`
    )[0];
    if (!order) throw new CheckConflictError("Order was not found.");
    if (Number(order.paid_cents) > 0)
      throw new CheckConflictError(
        "Checks cannot be rearranged after a tender has been committed.",
      );
    const source = (
      await sql`SELECT id FROM ordering_checks WHERE id=${input.fromCheckId} AND order_id=${input.orderId} FOR UPDATE`
    )[0];
    if (!source) throw new CheckConflictError("Source check was not found.");
    const sequence = Number(
      (
        await sql`SELECT COALESCE(MAX(display_sequence),0)+1 sequence FROM ordering_checks WHERE order_id=${input.orderId}`
      )[0].sequence,
    );
    const newCheckId = randomUUID();
    await sql`INSERT INTO ordering_checks(id,business,order_id,display_sequence,created_by) VALUES(${newCheckId},${input.business},${input.orderId},${sequence},${input.actor.id})`;
    for (const line of input.lines) {
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0)
        throw new CheckConflictError(
          "Split quantities must be positive whole numbers.",
        );
      const assignment = (
        await sql`SELECT quantity FROM ordering_check_line_assignments WHERE check_id=${input.fromCheckId} AND order_item_id=${line.orderItemId} FOR UPDATE`
      )[0];
      if (!assignment || Number(assignment.quantity) < line.quantity)
        throw new CheckConflictError(
          "A split quantity exceeds the quantity available on the source check.",
        );
      await sql`UPDATE ordering_check_line_assignments SET quantity=quantity-${line.quantity} WHERE check_id=${input.fromCheckId} AND order_item_id=${line.orderItemId}`;
      await sql`DELETE FROM ordering_check_line_assignments WHERE check_id=${input.fromCheckId} AND order_item_id=${line.orderItemId} AND quantity=0`;
      await sql`INSERT INTO ordering_check_line_assignments(check_id,order_item_id,quantity,allocated_cents) VALUES(${newCheckId},${line.orderItemId},${line.quantity},0)`;
    }
    await sql`DELETE FROM ordering_checks checks WHERE checks.id=${input.fromCheckId} AND NOT EXISTS (SELECT 1 FROM ordering_check_line_assignments assignment WHERE assignment.check_id=checks.id)`;
    await refreshCheckTotals(input.orderId);
    const checks = await listChecks(input.orderId, input.business);
    return { checks, newCheckId };
  });
}

export async function splitCheckEvenly(input: {
  orderId: string;
  business: OrderingBusiness;
  checkCount: number;
  actor: OrderingActor;
}) {
  await ensureInitialCheck(input.orderId, input.business, input.actor);
  if (
    !Number.isSafeInteger(input.checkCount) ||
    input.checkCount < 2 ||
    input.checkCount > 12
  )
    throw new CheckConflictError("Choose between 2 and 12 checks.");
  return withTransaction(async () => {
    const sql = getSql();
    const order = (
      await sql`SELECT id,total_cents,paid_cents FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`
    )[0];
    if (!order) throw new CheckConflictError("Order was not found.");
    if (Number(order.paid_cents) > 0)
      throw new CheckConflictError(
        "Checks cannot be rearranged after a tender has been committed.",
      );
    await sql`DELETE FROM ordering_checks WHERE order_id=${input.orderId}`;
    const base = Math.floor(Number(order.total_cents) / input.checkCount);
    let remainder = Number(order.total_cents) % input.checkCount;
    for (let sequence = 1; sequence <= input.checkCount; sequence += 1) {
      const checkId = randomUUID();
      const total = base + (remainder-- > 0 ? 1 : 0);
      await sql`INSERT INTO ordering_checks(id,business,order_id,display_sequence,total_cents,amount_due_cents,created_by) VALUES(${checkId},${input.business},${input.orderId},${sequence},${total},${total},${input.actor.id})`;
      if (sequence === 1)
        await sql`INSERT INTO ordering_check_line_assignments(check_id,order_item_id,quantity,allocated_cents) SELECT ${checkId},id,quantity,line_total_cents FROM ordering_order_items WHERE order_id=${input.orderId}`;
    }
    return { checks: await listChecks(input.orderId, input.business) };
  });
}

export async function assignChecks(input: {
  orderId: string;
  business: OrderingBusiness;
  checks: Array<Array<{ orderItemId: string; quantity: number }>>;
  actor: OrderingActor;
}) {
  await ensureInitialCheck(input.orderId, input.business, input.actor);
  const requestedChecks = input.checks.filter((check) => check.length > 0);
  if (requestedChecks.length < 1 || requestedChecks.length > 3)
    throw new CheckConflictError("Use between 1 and 3 non-empty checks.");
  return withTransaction(async () => {
    const sql = getSql();
    const order = (
      await sql`SELECT id,total_cents,paid_cents FROM ordering_orders WHERE id=${input.orderId} AND business=${input.business} FOR UPDATE`
    )[0];
    if (!order) throw new CheckConflictError("Order was not found.");
    if (Number(order.paid_cents) > 0)
      throw new CheckConflictError("The order cannot be split after payment has started.");
    const items =
      await sql`SELECT id,quantity,line_total_cents FROM ordering_order_items WHERE order_id=${input.orderId} ORDER BY sort_order,created_at,id`;
    const expected = new Map(items.map((item) => [String(item.id), Number(item.quantity)]));
    const assigned = new Map<string, number>();
    for (const check of requestedChecks) {
      for (const line of check) {
        if (!expected.has(line.orderItemId) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
          throw new CheckConflictError("The split contains an invalid order item.");
        assigned.set(line.orderItemId, (assigned.get(line.orderItemId) || 0) + line.quantity);
      }
    }
    for (const [itemId, quantity] of expected) {
      if (assigned.get(itemId) !== quantity)
        throw new CheckConflictError("Every item must be assigned to exactly one check.");
    }
    await sql`DELETE FROM ordering_checks WHERE order_id=${input.orderId}`;
    const itemById = new Map(items.map((item) => [String(item.id), item]));
    const itemTotal = items.reduce((sum, item) => sum + Number(item.line_total_cents), 0);
    const shared = Number(order.total_cents) - itemTotal;
    const sharedBase = Math.trunc(shared / requestedChecks.length);
    let sharedRemainder = shared - sharedBase * requestedChecks.length;
    for (let index = 0; index < requestedChecks.length; index += 1) {
      const checkId = randomUUID();
      const checkLines = requestedChecks[index];
      const linesTotal = checkLines.reduce((sum, line) => {
        const item = itemById.get(line.orderItemId)!;
        return sum + Math.round(Number(item.line_total_cents) * line.quantity / Number(item.quantity));
      }, 0);
      const adjustment = sharedBase + (sharedRemainder > 0 ? 1 : sharedRemainder < 0 ? -1 : 0);
      if (sharedRemainder > 0) sharedRemainder -= 1;
      if (sharedRemainder < 0) sharedRemainder += 1;
      const total = Math.max(0, linesTotal + adjustment);
      await sql`INSERT INTO ordering_checks(id,business,order_id,display_sequence,total_cents,amount_due_cents,created_by) VALUES(${checkId},${input.business},${input.orderId},${index + 1},${total},${total},${input.actor.id})`;
      for (const line of checkLines) {
        const item = itemById.get(line.orderItemId)!;
        const allocated = Math.round(Number(item.line_total_cents) * line.quantity / Number(item.quantity));
        await sql`INSERT INTO ordering_check_line_assignments(check_id,order_item_id,quantity,allocated_cents) VALUES(${checkId},${line.orderItemId},${line.quantity},${allocated})`;
      }
    }
    return { checks: await listChecks(input.orderId, input.business) };
  });
}

export async function listChecks(orderId: string, business: OrderingBusiness) {
  await ensureOrderingAccountSchema();
  const sql = getSql();
  const checks =
    await sql`SELECT * FROM ordering_checks WHERE order_id=${orderId} AND business=${business} ORDER BY display_sequence`;
  for (const check of checks)
    check.lines = await sql`
    SELECT assignment.order_item_id,assignment.quantity,assignment.allocated_cents,item.item_name_snapshot,item.modifier_total_cents
    FROM ordering_check_line_assignments assignment JOIN ordering_order_items item ON item.id=assignment.order_item_id
    WHERE assignment.check_id=${check.id} ORDER BY item.sort_order,item.created_at,item.id
  `;
  return checks;
}
