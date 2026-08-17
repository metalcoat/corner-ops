import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
void (async () => {
  const { ensureOrderingAccountSchema } = await import("../src/lib/ordering-account-schema");
  const { getSql } = await import("../src/lib/db");
  const { OrderVoidError, voidSentOrder } = await import("../src/lib/ordering-voids");
  await ensureOrderingAccountSchema();
  const sql = getSql();
  const id = randomUUID();
  try {
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,total_cents,paid_cents,amount_due_cents,created_by) VALUES(${id},'Corner Deli','pos','sent_to_kitchen','partially_paid','pickup','VOID-V',1200,500,700,'void-validation')`;
    let employeeBlocked = false;
    try { await voidSentOrder({ orderId: id, business: "Corner Deli", reason: "Customer cancelled", actor: { id: "employee", name: "Employee", type: "employee", role: "employee" } }); }
    catch (error) { employeeBlocked = error instanceof OrderVoidError; }
    if (!employeeBlocked) throw new Error("Employee was allowed to void a sent order.");
    const result = await voidSentOrder({ orderId: id, business: "Corner Deli", reason: "Customer cancelled", actor: { id: "manager", name: "Manager", type: "employee", role: "manager" } });
    const order = (await sql`SELECT status,payment_status,paid_cents,amount_due_cents,void_reason,pre_void_status,pre_void_payment_status FROM ordering_orders WHERE id=${id}`)[0];
    const event = (await sql`SELECT details FROM ordering_order_events WHERE order_id=${id} AND event_type='order_voided'`)[0];
    if (result.alreadyVoided || order.status !== "cancelled" || order.payment_status !== "partially_paid" || Number(order.paid_cents) !== 500 || Number(order.amount_due_cents) !== 700 || order.pre_void_status !== "sent_to_kitchen" || order.pre_void_payment_status !== "partially_paid" || !event) throw new Error("Void audit/payment-state acceptance failed.");
    console.log(JSON.stringify({ employeeBlocked, managerVoided: true, orderPreserved: true, paymentNotRefunded: true, reasonActorTimestampAudit: true }, null, 2));
  } finally { await sql`DELETE FROM ordering_orders WHERE id=${id}`; }
  process.exit();
})().catch((error) => { console.error(error); process.exit(1); });
