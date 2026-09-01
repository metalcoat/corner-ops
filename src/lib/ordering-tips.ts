import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingTipSchema } from "@/lib/ordering-tip-schema";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
export class TipError extends Error {}
function split(total: number, weights: Array<{ key: string; amount: number }>) {
  const positive = weights.filter((row) => row.amount > 0);
  if (!positive.length) return [{ key: "other", amount: total }];
  const sum = positive.reduce((n, row) => n + row.amount, 0);
  let used = 0;
  return positive.map((row, index) => {
    const amount =
      index === positive.length - 1
        ? total - used
        : Math.floor((total * row.amount) / sum);
    used += amount;
    return { key: row.key, amount };
  });
}
export async function reconcileOrderTips(orderId: string, business: string) {
  await ensureOrderingTipSchema();
  const sql = getSql(),
    order = (
      await sql`SELECT * FROM ordering_orders WHERE id=${orderId} AND business=${business}`
    )[0];
  if (!order || Number(order.tip_cents) <= 0 || order.payment_status !== "paid")
    return;
  const existing =
    await sql`SELECT id FROM ordering_tip_allocations WHERE order_id=${orderId} LIMIT 1`;
  if (existing.length) return;
  const policy = (
      await sql`SELECT * FROM ordering_tip_policies WHERE business=${business}`
    )[0],
    delivery = ["delivery", "no_contact_delivery"].includes(
      String(order.service_type),
    );
  let employees: any[] = [];
  if (delivery && policy.delivery_policy === "assigned_driver")
    employees =
      await sql`SELECT employee.id,employee.name FROM ordering_delivery_assignments assignment JOIN employees employee ON employee.id=assignment.driver_employee_id WHERE assignment.order_id=${orderId} AND assignment.status<>'cancelled' ORDER BY assignment.assigned_at DESC LIMIT 1`;
  const usePool =
    (delivery ? policy.delivery_policy : policy.counter_policy) === "pool";
  if (usePool)
    employees = policy.pool_clocked_in_only
      ? await sql`SELECT DISTINCT employee.id,employee.name FROM time_entries entry JOIN employees employee ON employee.id=entry.employee_id WHERE entry.business=${business} AND entry.clock_in<=COALESCE(${order.paid_at},NOW()) AND (entry.clock_out IS NULL OR entry.clock_out>=COALESCE(${order.paid_at},NOW())) AND employee.active=TRUE`
      : await sql`SELECT id,name FROM employees WHERE business=${business} AND active=TRUE AND pin_enabled=TRUE`;
  if (!employees.length && !usePool) {
    const actorId = String(
      delivery && policy.delivery_policy === "order_taker"
        ? order.created_by
        : order.paid_by || order.created_by,
    );
    employees =
      await sql`SELECT id,name FROM employees WHERE id::text=${actorId} AND business=${business} AND active=TRUE LIMIT 1`;
  }
  const tenders =
      await sql`SELECT tender_type,SUM(amount_cents)::integer amount FROM ordering_payment_transactions WHERE order_id=${orderId} AND transaction_type='payment' AND status='approved' GROUP BY tender_type`,
    tenderParts = split(
      Number(order.tip_cents),
      tenders.map((row) => ({
        key: String(row.tender_type),
        amount: Number(row.amount),
      })),
    ),
    employeeCount = Math.max(1, employees.length);
  let employeeUsed = 0;
  for (let index = 0; index < employeeCount; index++) {
    const employee = employees[index],
      employeeAmount =
        index === employeeCount - 1
          ? Number(order.tip_cents) - employeeUsed
          : Math.floor(Number(order.tip_cents) / employeeCount);
    employeeUsed += employeeAmount;
    let tenderUsed = 0;
    for (let tenderIndex = 0; tenderIndex < tenderParts.length; tenderIndex++) {
      const part = tenderParts[tenderIndex],
        amount =
          tenderIndex === tenderParts.length - 1
            ? employeeAmount - tenderUsed
            : Math.floor(
                (employeeAmount * part.amount) / Number(order.tip_cents),
              );
      tenderUsed += amount;
      if (amount <= 0) continue;
      await sql`INSERT INTO ordering_tip_allocations(id,business,order_id,employee_id,employee_name,tender_type,amount_cents,status,allocation_reason)VALUES(${randomUUID()},${business},${orderId},${employee?.id || null},${employee?.name || "Unassigned"},${["cash", "card", "gift_card"].includes(part.key) ? part.key : "other"},${amount},${employee ? "eligible" : "unassigned"},${usePool ? "Tip pool" : delivery ? "Assigned delivery driver" : "Order cashier"}) ON CONFLICT DO NOTHING`;
    }
  }
}
export async function tipsDashboard() {
  await ensureOrderingTipSchema();
  const sql = getSql();
  const orders =
    await sql`SELECT id FROM ordering_orders WHERE business='Corner Deli' AND payment_status='paid' AND tip_cents>0 AND NOT EXISTS(SELECT 1 FROM ordering_tip_allocations allocation WHERE allocation.order_id=ordering_orders.id) ORDER BY paid_at DESC LIMIT 500`;
  for (const row of orders)
    await reconcileOrderTips(String(row.id), "Corner Deli");
  await sql`UPDATE ordering_tip_allocations allocation SET employee_id=driver.id,employee_name=driver.name,status='eligible',allocation_reason='Assigned delivery driver',updated_at=NOW() FROM ordering_orders orders JOIN LATERAL(SELECT employee.id,employee.name FROM ordering_delivery_assignments assignment JOIN employees employee ON employee.id=assignment.driver_employee_id WHERE assignment.order_id=orders.id AND assignment.status<>'cancelled' ORDER BY assignment.assigned_at DESC LIMIT 1)driver ON TRUE WHERE allocation.order_id=orders.id AND allocation.status='unassigned' AND orders.service_type IN('delivery','no_contact_delivery')`;
  await sql`UPDATE ordering_tip_allocations allocation SET status='reversed',updated_at=NOW() FROM ordering_orders orders WHERE allocation.order_id=orders.id AND allocation.status IN('unassigned','eligible') AND orders.payment_status='refunded'`;
  const [policy, summary, employees, allocations, batches] = await Promise.all([
    sql`SELECT * FROM ordering_tip_policies WHERE business='Corner Deli'`,
    sql`SELECT status,tender_type,SUM(amount_cents)::integer amount_cents,COUNT(*)::integer allocation_count FROM ordering_tip_allocations WHERE business='Corner Deli' GROUP BY status,tender_type`,
    sql`SELECT employee.id employee_id,employee.name employee_name,COALESCE(SUM(allocation.amount_cents)FILTER(WHERE allocation.status='eligible'),0)::integer eligible_cents,COALESCE(SUM(allocation.amount_cents)FILTER(WHERE allocation.status='paid'),0)::integer paid_cents FROM employees employee LEFT JOIN ordering_tip_allocations allocation ON allocation.employee_id=employee.id AND allocation.business='Corner Deli' WHERE employee.business='Corner Deli' AND employee.active=TRUE GROUP BY employee.id,employee.name ORDER BY employee.name`,
    sql`SELECT allocation.*,orders.display_number,orders.service_type,orders.paid_at FROM ordering_tip_allocations allocation JOIN ordering_orders orders ON orders.id=allocation.order_id WHERE allocation.business='Corner Deli' ORDER BY allocation.created_at DESC LIMIT 500`,
    sql`SELECT * FROM ordering_tip_payout_batches WHERE business='Corner Deli' ORDER BY created_at DESC LIMIT 100`,
  ]);
  return { policy: policy[0], summary, employees, allocations, batches };
}
export async function tipAction(
  body: Record<string, unknown>,
  actor: OrderingActor,
) {
  await ensureOrderingTipSchema();
  if (!canManagePos(actor))
    throw new TipError("Manager or owner approval is required.");
  const sql = getSql(),
    action = String(body.action || "");
  if (action === "policy")
    return (
      await sql`UPDATE ordering_tip_policies SET delivery_policy=${String(body.deliveryPolicy)},counter_policy=${String(body.counterPolicy)},pool_clocked_in_only=${body.poolClockedInOnly !== false},updated_by=${actor.id},updated_at=NOW() WHERE business='Corner Deli' RETURNING *`
    )[0];
  if (action === "assign") {
    const id = String(body.id || ""),
      employeeId = String(body.employeeId || ""),
      employee = (
        await sql`SELECT id,name FROM employees WHERE id=${employeeId} AND business='Corner Deli' AND active=TRUE`
      )[0];
    if (!employee) throw new TipError("Choose an active employee.");
    return (
      await sql`UPDATE ordering_tip_allocations SET employee_id=${employee.id},employee_name=${employee.name},status='eligible',allocation_reason='Manager assigned',updated_at=NOW() WHERE id=${id} AND business='Corner Deli' AND status='unassigned' RETURNING *`
    )[0];
  }
  if (action === "payout")
    return withTransaction(async () => {
      const employeeId = body.employeeId ? String(body.employeeId) : null,
        periodStart = body.periodStart ? String(body.periodStart) : null,
        periodEnd = body.periodEnd ? String(body.periodEnd) : null,
        rows =
          await sql`SELECT allocation.* FROM ordering_tip_allocations allocation JOIN ordering_orders orders ON orders.id=allocation.order_id WHERE allocation.business='Corner Deli' AND allocation.status='eligible' AND (${employeeId}::text IS NULL OR allocation.employee_id::text=${employeeId}) AND (${periodStart}::date IS NULL OR orders.paid_at::date>=${periodStart}::date) AND (${periodEnd}::date IS NULL OR orders.paid_at::date<=${periodEnd}::date) FOR UPDATE`;
      if (!rows.length)
        throw new TipError("There are no eligible tips to pay out.");
      const id = randomUUID(),
        total = rows.reduce((n, row) => n + Number(row.amount_cents), 0),
        count = new Set(rows.map((row) => String(row.employee_id))).size;
      await sql`INSERT INTO ordering_tip_payout_batches(id,business,total_cents,employee_count,period_start,period_end,created_by,approved_by,notes)VALUES(${id},'Corner Deli',${total},${count},${body.periodStart ? String(body.periodStart) : null},${body.periodEnd ? String(body.periodEnd) : null},${actor.id},${actor.id},${String(body.notes || "")})`;
      await sql`UPDATE ordering_tip_allocations SET status='paid',payout_batch_id=${id},updated_at=NOW() WHERE id=ANY(${rows.map((row) => String(row.id))}::uuid[])`;
      return { id, totalCents: total, employeeCount: count };
    });
  if (action === "reverse_payout")
    return withTransaction(async () => {
      const id = String(body.id || ""),
        batch = (
          await sql`UPDATE ordering_tip_payout_batches SET status='reversed',reversed_at=NOW() WHERE id=${id} AND business='Corner Deli' AND status='posted' RETURNING *`
        )[0];
      if (!batch)
        throw new TipError(
          "Payout batch was not found or was already reversed.",
        );
      await sql`UPDATE ordering_tip_allocations SET status='eligible',payout_batch_id=NULL,updated_at=NOW() WHERE payout_batch_id=${id}`;
      return batch;
    });
  throw new TipError("Unknown tip action.");
}
export async function tipCsv() {
  const data = await tipsDashboard();
  const rows = ["Employee,Tender,Status,Amount,Order,Paid At"];
  for (const row of data.allocations)
    rows.push(
      [
        row.employee_name,
        row.tender_type,
        row.status,
        (Number(row.amount_cents) / 100).toFixed(2),
        row.display_number,
        row.paid_at ? new Date(row.paid_at).toISOString() : "",
      ]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(","),
    );
  return rows.join("\n");
}
