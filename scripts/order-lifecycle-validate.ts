#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) {
  throw new Error("Order lifecycle validation requires the private local Corner Ops PostgreSQL container.");
}
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

const ROLLBACK = "rollback:order-lifecycle-validation";

async function main(): Promise<void> {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { OrderConflictError, submitDraftOrder, transitionKitchenOrder } = await import("../src/lib/ordering-order-lifecycle");
  await ensureOrderingPosSchema();

  type MenuOption = { group_id: string; group_name: string; option_id: string; option_name: string; min_selections: number };
  async function configured(itemName: string, variantName: string, requested: string[]) {
    const sql = getSql();
    const items = await sql`SELECT id FROM ordering_menu_items WHERE business = 'Corner Deli' AND name = ${itemName} AND active = TRUE LIMIT 1`;
    if (!items[0]) throw new Error(`Missing imported menu item ${itemName}.`);
    const variants = await sql`SELECT id FROM ordering_menu_item_variants WHERE item_id = ${items[0].id} AND name = ${variantName} AND active = TRUE LIMIT 1`;
    if (!variants[0]) throw new Error(`Missing ${itemName} variant ${variantName}.`);
    const options = await sql`
      SELECT grp.id AS group_id, grp.name AS group_name, grp.min_selections, opt.id AS option_id, opt.name AS option_name
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active = TRUE
      JOIN ordering_modifier_options opt ON opt.group_id = grp.id AND opt.active = TRUE AND opt.available = TRUE
      WHERE link.item_id = ${items[0].id}
      ORDER BY link.sort_order, opt.sort_order, opt.name
    ` as MenuOption[];
    const selections: Record<string, string[]> = {};
    for (const option of options) {
      selections[option.group_id] ||= [];
      if (requested.includes(option.option_name)) selections[option.group_id].push(option.option_id);
    }
    for (const option of options) {
      while (selections[option.group_id].length < Number(option.min_selections)) {
        const candidate = options.find((row) => row.group_id === option.group_id && !selections[row.group_id].includes(row.option_id));
        if (!candidate) throw new Error(`Cannot satisfy required modifiers for ${itemName}.`);
        selections[option.group_id].push(candidate.option_id);
      }
    }
    const pizzaToppings = options.filter((option) => option.group_name === "Pizza Toppings" && requested.includes(option.option_name)).map((option) => ({ modifierOptionId: option.option_id, portion: "whole" as const, amount: "regular" as const }));
    for (const option of options.filter((candidate) => candidate.group_name === "Pizza Toppings")) selections[option.group_id] = [];
    return { itemId: String(items[0].id), variantId: String(variants[0].id), selections, pizzaToppings };
  }

  const results: Record<string, unknown> = {};
  const lifecycleActor = { id: "order-lifecycle-test", name: "Lifecycle Test", type: "employee" as const };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const pizza = await configured("Pizza", 'Jumbo Thin 16"', ["Pepperoni", "Mushrooms"]);
      const draft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "order-lifecycle-test",
        items: [{ itemId: pizza.itemId, variantId: pizza.variantId, modifierSelections: pizza.selections, pizzaToppings: pizza.pizzaToppings, specialInstructions: "Lifecycle pizza note" }],
      });
      const before = (await sql`SELECT total_cents FROM ordering_orders WHERE id = ${draft.id}`)[0];
      const submitted = await submitDraftOrder(String(draft.id), "Corner Deli", lifecycleActor);
      if (submitted.order.status !== "sent_to_kitchen" || !submitted.order.submitted_at) throw new Error("Draft did not become submitted.");
      const duplicate = await submitDraftOrder(String(draft.id), "Corner Deli", lifecycleActor);
      if (!duplicate.alreadySubmitted || duplicate.order.display_number !== submitted.order.display_number) throw new Error("Duplicate submission was not idempotent.");

      const snapshotBefore = (await sql`SELECT unit_price_cents, modifier_total_cents, line_total_cents FROM ordering_order_items WHERE order_id = ${draft.id}`)[0];
      await sql`UPDATE ordering_menu_item_variants SET base_price_cents = base_price_cents + 37 WHERE id = ${pizza.variantId}`;
      const snapshotAfter = (await sql`SELECT unit_price_cents, modifier_total_cents, line_total_cents FROM ordering_order_items WHERE order_id = ${draft.id}`)[0];
      if (JSON.stringify(snapshotBefore) !== JSON.stringify(snapshotAfter)) throw new Error("Submitted line snapshots changed with menu pricing.");

      let invalidRejected = false;
      try {
        await transitionKitchenOrder({ orderId: String(draft.id), business: "Corner Deli", expectedStatus: "sent_to_kitchen", nextStatus: "ready", actor: lifecycleActor });
      } catch (error) { invalidRejected = error instanceof OrderConflictError; }
      if (!invalidRejected) throw new Error("Invalid submitted-to-ready transition was accepted.");

      await transitionKitchenOrder({ orderId: String(draft.id), business: "Corner Deli", expectedStatus: "sent_to_kitchen", nextStatus: "in_progress", actor: lifecycleActor });
      let staleRejected = false;
      try {
        await transitionKitchenOrder({ orderId: String(draft.id), business: "Corner Deli", expectedStatus: "sent_to_kitchen", nextStatus: "in_progress", actor: lifecycleActor });
      } catch (error) { staleRejected = error instanceof OrderConflictError; }
      if (!staleRejected) throw new Error("A stale duplicate kitchen transition was accepted.");
      await transitionKitchenOrder({ orderId: String(draft.id), business: "Corner Deli", expectedStatus: "in_progress", nextStatus: "ready", actor: lifecycleActor });
      await transitionKitchenOrder({ orderId: String(draft.id), business: "Corner Deli", expectedStatus: "ready", nextStatus: "completed", actor: lifecycleActor });
      const completed = (await sql`SELECT status, submitted_at, started_at, ready_at, completed_at FROM ordering_orders WHERE id = ${draft.id}`)[0];
      if (completed.status !== "completed" || !completed.submitted_at || !completed.started_at || !completed.ready_at || !completed.completed_at) throw new Error("Lifecycle timestamps were not recorded.");

      const staleDraft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "order-lifecycle-test",
        items: [{ itemId: pizza.itemId, variantId: pizza.variantId, modifierSelections: pizza.selections }],
      });
      await sql`UPDATE ordering_menu_item_variants SET base_price_cents = base_price_cents + 11 WHERE id = ${pizza.variantId}`;
      let stalePriceRejected = false;
      try { await submitDraftOrder(String(staleDraft.id), "Corner Deli", lifecycleActor); }
      catch (error) { stalePriceRejected = error instanceof OrderConflictError && error.message.includes("price"); }
      if (!stalePriceRejected) throw new Error("Stale menu pricing was submitted.");

      const wings = await configured("Wings", "10 Wings", ["Mild", "Flats/Wings"]);
      const wingDraft = await createDraftOrderWithVariants({
        business: "Corner Deli", source: "pos", serviceType: "dine_in", createdBy: "order-lifecycle-test",
        items: [{ itemId: wings.itemId, variantId: wings.variantId, modifierSelections: wings.selections, specialInstructions: "Lifecycle wing note" }],
      });
      if (String(wingDraft.display_number) === String(draft.display_number) || String(staleDraft.display_number) === String(draft.display_number)) {
        throw new Error("Order counter produced duplicate display numbers.");
      }
      await submitDraftOrder(String(wingDraft.id), "Corner Deli", lifecycleActor);
      await transitionKitchenOrder({ orderId: String(wingDraft.id), business: "Corner Deli", expectedStatus: "sent_to_kitchen", nextStatus: "in_progress", actor: lifecycleActor });
      await transitionKitchenOrder({ orderId: String(wingDraft.id), business: "Corner Deli", expectedStatus: "in_progress", nextStatus: "ready", actor: lifecycleActor });
      await transitionKitchenOrder({ orderId: String(wingDraft.id), business: "Corner Deli", expectedStatus: "ready", nextStatus: "completed", actor: lifecycleActor });
      const wingSnapshot = (await sql`
        SELECT item.variant_name_snapshot, item.special_instructions,
               ARRAY_AGG(modifier.option_name_snapshot ORDER BY modifier.option_name_snapshot) FILTER (WHERE modifier.selection_state IN ('selected','extra')) AS modifiers
        FROM ordering_order_items item
        LEFT JOIN ordering_order_item_modifiers modifier ON modifier.order_item_id = item.id
        WHERE item.order_id = ${wingDraft.id}
        GROUP BY item.id
      `)[0];
      if (wingSnapshot.variant_name_snapshot !== "10 Wings" || wingSnapshot.special_instructions !== "Lifecycle wing note") throw new Error("Non-pizza snapshot failed.");

      const eventCount = Number((await sql`SELECT COUNT(*)::INTEGER AS count FROM ordering_order_events WHERE order_id IN (${draft.id}, ${wingDraft.id}) AND event_type = 'status_changed'`)[0].count);
      if (eventCount !== 8) throw new Error(`Expected 8 status audit events, found ${eventCount}.`);
      results.draftToSubmitted = true;
      results.duplicateSubmissionIdempotent = true;
      results.snapshotImmutable = true;
      results.stalePriceRejected = true;
      results.invalidTransitionRejected = true;
      results.staleTransitionRejected = true;
      results.validTransitionsAndTimestamps = true;
      results.uniqueOrderNumbers = [draft.display_number, staleDraft.display_number, wingDraft.display_number];
      results.pizzaTotalCents = Number(before.total_cents);
      results.nonPizzaAcceptance = wingSnapshot;
      results.statusAuditEvents = eventCount;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  const leftovers = Number((await getSql()`SELECT COUNT(*)::INTEGER AS count FROM ordering_orders WHERE created_by = 'order-lifecycle-test'`)[0].count);
  if (leftovers !== 0) throw new Error(`Lifecycle tests left ${leftovers} test orders behind.`);
  results.rollbackIsolation = true;
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
