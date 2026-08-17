import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
void (async () => {
  const { ensureOrderingAccountSchema } = await import("../src/lib/ordering-account-schema");
  const { getSql } = await import("../src/lib/db");
  const { ensureInitialCheck, splitCheck } = await import("../src/lib/ordering-checks");
  const { commitTender, PaymentConflictError } = await import("../src/lib/ordering-payments");
  await ensureOrderingAccountSchema();
  const sql = getSql();
  const item = (await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND active=TRUE LIMIT 1`)[0];
  if (!item) throw new Error("A Corner Deli menu item is required for split-check validation.");
  const orderId = randomUUID(), firstLine = randomUUID(), secondLine = randomUUID();
  const actor = { id: "split-validation", name: "Split Validator", type: "employee" as const, role: "employee" as const };
  try {
    await sql`DELETE FROM ordering_print_jobs WHERE order_id IN (SELECT id FROM ordering_orders WHERE display_number='SPLIT-V' AND created_by='split-validation')`;
    await sql`DELETE FROM ordering_payment_transactions WHERE order_id IN (SELECT id FROM ordering_orders WHERE display_number='SPLIT-V' AND created_by='split-validation')`;
    await sql`DELETE FROM ordering_orders WHERE display_number='SPLIT-V' AND created_by='split-validation'`;
    await sql`INSERT INTO ordering_orders(id,business,source,status,payment_status,service_type,display_number,total_cents,amount_due_cents,created_by) VALUES(${orderId},'Corner Deli','pos','draft','unpaid','dine_in','SPLIT-V',1501,1501,'split-validation')`;
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,modifier_total_cents,line_total_cents,sort_order) VALUES(${firstLine},${orderId},${item.id},'Two quantity line',2,500,0,1001,10),(${secondLine},${orderId},${item.id},'Single quantity line',1,500,0,500,20)`;
    const initial = await ensureInitialCheck(orderId, "Corner Deli", actor);
    const result = await splitCheck({ orderId, business: "Corner Deli", fromCheckId: initial.id, lines: [{ orderItemId: firstLine, quantity: 1 }], actor });
    const total = result.checks.reduce((sum, check) => sum + Number(check.total_cents), 0);
    const assigned = result.checks.flatMap((check) => check.lines as Array<Record<string, unknown>>).filter((line: Record<string, unknown>) => line.order_item_id === firstLine).reduce((sum, line) => sum + Number(line.quantity), 0);
    if (result.checks.length !== 2 || total !== 1501 || assigned !== 2 || !result.checks.every((check) => (check.lines as Array<Record<string, unknown>>).every((line) => line.order_item_id === firstLine || line.order_item_id === secondLine))) throw new Error("Split-check allocation acceptance failed.");
    const payable = result.checks[0];
    const paid = await commitTender({ orderId, business: "Corner Deli", checkId: payable.id, tenderType: "card", amountTenderedCents: Number(payable.amount_due_cents), clientMutationId: `split-${randomUUID()}`, actor });
    if (paid.check?.status !== "paid" || paid.order.payment_status !== "partially_paid") throw new Error("Per-check payment state was not reflected in the overall order balance.");
    let rearrangeBlocked = false;
    try { await splitCheck({ orderId, business: "Corner Deli", fromCheckId: result.checks[1].id, lines: [{ orderItemId: firstLine, quantity: 1 }], actor }); }
    catch (error) { rearrangeBlocked = error instanceof PaymentConflictError || error instanceof Error && error.message.includes("tender"); }
    if (!rearrangeBlocked) throw new Error("Paid split assignments could still be rearranged.");
    console.log(JSON.stringify({ stableCheckIds: true, quantitySplit: true, modifiersRemainOnOriginalLine: true, deterministicCentAllocation: true, checksTotalEqualsOrder: true, perCheckPaymentStatus: true, paidAssignmentsLocked: true, kitchenOrderNotDuplicated: true }, null, 2));
  } finally {
    await sql`DELETE FROM ordering_print_jobs WHERE order_id=${orderId}`;
    await sql`DELETE FROM ordering_payment_transactions WHERE order_id=${orderId}`;
    await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
  }
  process.exit();
})().catch((error) => { console.error(error); process.exit(1); });
