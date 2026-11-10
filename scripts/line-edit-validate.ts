// EDIT on saved POS lines, end to end: who may edit, the CHANGED kitchen ticket, and the order history.
// Runs only against a throwaway copy of the database (LINE_EDIT_DATABASE_URL, name containing "test"),
// with the copy's printers pointed at 127.0.0.1:19100, where this script listens as a fake printer.
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

const url = new URL(process.env.LINE_EDIT_DATABASE_URL || "postgresql://invalid/none");
if (!/test/.test(url.pathname)) throw new Error("Set LINE_EDIT_DATABASE_URL to a throwaway test copy of the database.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = url.toString();
process.env.VALIDATION_DISABLE_OUTBOUND = "1";

const printed: string[] = [];
const printer = createServer((socket) => socket.on("data", (chunk) => printed.push(chunk.toString("latin1")))).listen(19100, "127.0.0.1");

function check(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
  console.log(`ok - ${message}`);
}

void (async () => {
  const { getSql } = await import("../src/lib/db");
  const { orderingMenuWithVariants } = await import("../src/lib/ordering-menu-variants");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder, reopenOrderForAdditions } = await import("../src/lib/ordering-order-lifecycle");
  const { dispatchSubmittedOrderPrintJobs } = await import("../src/lib/ordering-auto-print");
  const { editOrderLine } = await import("../src/lib/ordering-line-edits");
  const { cancelOrderItem, lineWasSent } = await import("../src/lib/ordering-item-cancellations");
  const { getOrderDetail } = await import("../src/lib/ordering-order-center");
  const { savedLineConfiguration } = await import("../src/lib/ordering-line-edit-rules");
  const sql = getSql();
  if ((await sql`SELECT current_database() db`)[0].db !== url.pathname.slice(1)) throw new Error("Connected to the wrong database.");
  const staff = { id: "line-edit-staff", name: "Sam Staff", type: "employee" as const, role: "employee" as const };
  const manager = { id: "line-edit-manager", name: "Mandy Manager", type: "employee" as const, role: "manager" as const };
  const override = { approved: true, reason: "Line edit validation" };

  const items = (await orderingMenuWithVariants("Corner Deli")).flatMap((category) => category.items);
  const pizza = items.find((item) => item.available && item.modifiers.some((group) => group.presentationBehavior === "pizza_topping" && group.options.filter((option) => option.available).length >= 3));
  if (!pizza) throw new Error("No pizza with toppings on this menu copy.");
  const toppingGroup = pizza.modifiers.find((group) => group.presentationBehavior === "pizza_topping")!;
  const [pepperoni, sausage, onions] = toppingGroup.options.filter((option) => option.available);
  const variant = pizza.variants.find((candidate) => candidate.available) || null;
  // Required non-topping choices: the first option of each.
  const required = Object.fromEntries(pizza.modifiers.filter((group) => group.presentationBehavior !== "pizza_topping" && group.minSelections > 0 && group.presentationContext !== "dependent").map((group) => [group.id, group.options.filter((option) => option.available).slice(0, group.minSelections).map((option) => option.id)]));
  const ring = (toppings: string[], quantity = 1) => ({ itemId: pizza.id, variantId: variant?.id || null, quantity, modifierSelections: required, pizzaToppings: toppings.map((modifierOptionId) => ({ modifierOptionId, portion: "whole" as const, amount: "regular" as const })) });
  const newOrder = async () => (await createDraftOrderWithVariants({ business: "Corner Deli", source: "pos", serviceType: "pickup", customerFirstName: "Edit", customerLastName: "Test", callerPhone: "3155550100", createdBy: staff.id, createdByName: staff.name, items: [ring([pepperoni.id])] })).id as string;
  const lines = async (orderId: string) => (await getOrderDetail("Corner Deli", orderId))!.items as Array<Record<string, any>>;
  const live = (rows: Array<Record<string, any>>) => rows.filter((row) => Number(row.quantity) > Number(row.cancelled_quantity));
  const tickets = async (orderId: string) => (await sql`SELECT payload FROM ordering_print_jobs WHERE order_id=${orderId} AND purpose='kitchen_production' ORDER BY created_at`).map((row) => row.payload as { heading: string; lines: string[] });
  const orders: string[] = [];
  try {
    // 1. A sent line: staff can't change it, a manager can, and the kitchen gets only the change.
    const sentOrder = await newOrder();
    orders.push(sentOrder);
    await submitDraftOrder(sentOrder, "Corner Deli", manager, override);
    await dispatchSubmittedOrderPrintJobs(sentOrder, "Corner Deli");
    await reopenOrderForAdditions(sentOrder, "Corner Deli", staff);
    const [original] = await lines(sentOrder);
    check(savedLineConfiguration(original as never).pizzaToppings.map((topping) => topping.modifierOptionId).join() === pepperoni.id, "the item screen pre-fills the saved toppings");
    let refused = "";
    try { await editOrderLine({ orderId: sentOrder, itemId: original.id, item: ring([sausage.id]), reason: "Wrong topping", clientMutationId: randomUUID(), actor: staff }); } catch (error) { refused = String((error as Error).message); }
    check(/Manager authorization/.test(refused), "staff can't change a sent line without a manager PIN");
    const first = await editOrderLine({ orderId: sentOrder, itemId: original.id, item: ring([sausage.id]), reason: "Wrong topping", clientMutationId: randomUUID(), actor: staff, approver: manager });
    check(first.sent, "the edit is recorded as a change to a sent line");
    const order = (await sql`SELECT * FROM ordering_orders WHERE id=${sentOrder}`)[0];
    check(await lineWasSent(order, first.newItemId!), "the replacement line still counts as sent (voiding it needs a manager)");
    const again = await editOrderLine({ orderId: sentOrder, itemId: first.newItemId!, item: ring([sausage.id, onions.id], 2), reason: "Customer wants two, add onions", clientMutationId: randomUUID(), actor: staff, approver: manager });
    const replay = await editOrderLine({ orderId: sentOrder, itemId: first.newItemId!, item: ring([sausage.id, onions.id], 2), reason: "Customer wants two, add onions", clientMutationId: (await sql`SELECT details->>'clientMutationId' id FROM ordering_order_events WHERE order_id=${sentOrder} AND event_type='order_item_edited' ORDER BY created_at DESC LIMIT 1`)[0].id, actor: staff, approver: manager });
    check("duplicate" in replay && replay.newItemId === again.newItemId, "a repeated save is not applied twice");
    const after = live(await lines(sentOrder));
    check(after.length === 1 && after[0].id === again.newItemId && Number(after[0].quantity) === 2, "the order shows one line, the new version");
    check(Number(after[0].sort_order) === Number(original.sort_order), "the new version keeps the old line's place");
    await submitDraftOrder(sentOrder, "Corner Deli", manager, override);
    const printedBefore = printed.length;
    await dispatchSubmittedOrderPrintJobs(sentOrder, "Corner Deli");
    const changeTicket = (await tickets(sentOrder)).at(-1)!;
    console.log(changeTicket.lines.join("\n"));
    check(changeTicket.heading === "ORDER CHANGE", "the ticket is headed ORDER CHANGE");
    check(changeTicket.lines[0].startsWith("** CHANGED ** 2x "), "it starts ** CHANGED ** with the new quantity");
    const body = changeTicket.lines.join("\n");
    check(body.includes(`- ${pepperoni.name.toUpperCase()}`) && body.includes(`+ ${sausage.name.toUpperCase()}`) && body.includes(`+ ${onions.name.toUpperCase()}`) && body.includes("QTY: 1 -> 2"), "it lists - old topping, + new toppings and the quantity");
    check(!/VOID/.test(body) && changeTicket.lines.length === 5, "no void line and no full re-print of the item");
    console.log((await sql`SELECT status,error_message,device_id FROM ordering_print_jobs WHERE order_id=${sentOrder} ORDER BY created_at`).map((row) => `${row.status} ${row.error_message || ""}`).join("\n"));
    check(printed.length > printedBefore && printed.slice(printedBefore).join("").includes("CHANGED"), "the fake kitchen printer received the CHANGED ticket");
    const trail = (await getOrderDetail("Corner Deli", sentOrder))!.trail as Array<{ label: string; detail?: string; who: string }>;
    const edits = trail.filter((row) => row.label === "Item changed after it was sent");
    check(edits.length === 2 && edits[1].detail?.includes("approved by Mandy Manager") && !trail.some((row) => row.label === "Item voided"), "order history shows both changes with who approved, and no voids");

    // 2. A line not sent yet: anyone can change it and nothing extra prints.
    const draft = await newOrder();
    orders.push(draft);
    const [unsent] = await lines(draft);
    const edited = await editOrderLine({ orderId: draft, itemId: unsent.id, item: ring([sausage.id]), reason: "", clientMutationId: randomUUID(), actor: staff });
    check(!edited.sent, "staff can change a line the kitchen doesn't have yet, with no PIN or reason");
    await submitDraftOrder(draft, "Corner Deli", manager, override);
    const [firstTicket] = await tickets(draft);
    const firstBody = firstTicket.lines.join("\n");
    check(firstTicket.heading === "KITCHEN ORDER" && firstBody.includes(sausage.name.toUpperCase()) && !firstBody.includes(pepperoni.name.toUpperCase()) && !/CHANGED|VOID/.test(firstBody), "the first ticket shows only the changed version");

    // 3. Voided before Send in a reopened order: the kitchen never saw it, so nothing about it prints.
    await reopenOrderForAdditions(draft, "Corner Deli", staff);
    const { appendConfiguredOrderItemsWithVariants } = await import("../src/lib/ordering-orders-with-variants");
    const [extra] = await appendConfiguredOrderItemsWithVariants(draft, "Corner Deli", [ring([onions.id])]);
    await cancelOrderItem({ orderId: draft, itemId: extra, quantity: 1, reason: "Rang in wrong", clientMutationId: randomUUID(), actor: staff });
    const ticketCount = (await tickets(draft)).length;
    await submitDraftOrder(draft, "Corner Deli", manager, override);
    check((await tickets(draft)).length === ticketCount, "no empty kitchen ticket for a line added and voided before Send");

    // 4. Same menu item only, and no change means no save.
    let sameRefused = "";
    await reopenOrderForAdditions(draft, "Corner Deli", staff);
    const [current] = live(await lines(draft));
    try { await editOrderLine({ orderId: draft, itemId: current.id, item: ring([sausage.id]), reason: "Testing no change", clientMutationId: randomUUID(), actor: manager }); } catch (error) { sameRefused = String((error as Error).message); }
    check(/Nothing changed/.test(sameRefused), `saving with no change is refused (${sameRefused || "it was saved"})`);
    console.log("PASS line edits");
  } finally {
    for (const id of orders) {
      await sql`DELETE FROM ordering_print_jobs WHERE order_id=${id}`;
      await sql`DELETE FROM ordering_order_item_cancellations WHERE order_id=${id}`;
      await sql`DELETE FROM ordering_inventory_movements WHERE order_id=${id}`;
      await sql`DELETE FROM ordering_orders WHERE id=${id}`.catch((error) => console.error("cleanup", id, error.message));
    }
    printer.close();
  }
})().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
