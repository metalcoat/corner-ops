import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.VALIDATION_DATABASE_URL || process.env.ORDERING_AUDIT_DATABASE !== "1") {
  throw new Error("An explicitly isolated audit database is required.");
}
process.env.DATABASE_URL = process.env.VALIDATION_DATABASE_URL;
process.env.DATABASE_DRIVER = "postgres";
process.env.VALIDATION_DISABLE_OUTBOUND = "1";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder, OrderConflictError } = await import("../src/lib/ordering-order-lifecycle");
  const rollback = new Error("rollback:modifier-fee-combo-regressions");
  let checks = 0;
  const failures: string[] = [];
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const category = (await sql`SELECT id FROM ordering_menu_categories WHERE business='Corner Deli' AND active ORDER BY id LIMIT 1`)[0];
      assert.ok(category, "A menu category is required.");
      const itemId = randomUUID(), variantId = randomUUID(), groupId = randomUUID(), optionId = randomUUID();
      const comboId = randomUUID(), comboGroupId = randomUUID(), comboOptionId = randomUUID();
      await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${itemId},'Corner Deli',${category.id},${`Audit fee meal ${itemId}`},1000)`;
      await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents) VALUES(${variantId},${itemId},'Audit size',1200)`;
      await sql`INSERT INTO ordering_modifier_groups(id,business,name,max_selections,allow_option_quantity,selection_charge_cents) VALUES(${groupId},'Corner Deli',${`Audit fee ${groupId}`},1,TRUE,25)`;
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents) VALUES(${optionId},${groupId},'Audit sauce',100)`;
      await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id) VALUES(${randomUUID()},${itemId},${groupId})`;
      await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,included_choice_count) VALUES(${itemId},${groupId},1)`;
      await sql`INSERT INTO ordering_menu_variant_modifier_prices(id,variant_id,option_id,price_delta_cents) VALUES(${randomUUID()},${variantId},${optionId},175)`;
      await sql`INSERT INTO ordering_combo_definitions(id,business,name,base_price_delta_cents) VALUES(${comboId},'Corner Deli',${`Audit combo ${comboId}`},300)`;
      await sql`INSERT INTO ordering_menu_item_combos(id,item_id,combo_id) VALUES(${randomUUID()},${itemId},${comboId})`;
      await sql`INSERT INTO ordering_combo_groups(id,combo_id,name) VALUES(${comboGroupId},${comboId},'Audit side')`;
      await sql`INSERT INTO ordering_combo_options(id,group_id,name,price_delta_cents) VALUES(${comboOptionId},${comboGroupId},'Audit fries',75)`;
      const actor = { id: "pricing-audit", name: "Pricing audit", type: "employee" as const, role: "owner" as const };
      const create = (item: Partial<NonNullable<Parameters<typeof createDraftOrderWithVariants>[0]["items"]>[number]>) => createDraftOrderWithVariants({
        business: "Corner Deli", source: "web", serviceType: "pickup", createdBy: actor.id,
        customerFirstName: "Pricing audit", callerPhone: "3155550199", items: [{ itemId, variantId, ...item }],
      });
      const submit = (id: string) => submitDraftOrder(id, "Corner Deli", actor, { approved: true, reason: "Isolated pricing audit" });
      const check = async (label: string, run: () => Promise<void>) => {
        await sql`SAVEPOINT pricing_case`;
        try { await run(); checks++; }
        catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
        finally { await sql`ROLLBACK TO SAVEPOINT pricing_case`; }
      };

      for (const allowance of [0, 1, 2]) for (const quantity of [1, 2, 3, 99]) {
        await check(`fee + ${allowance} included + quantity ${quantity}`, async () => {
          await sql`UPDATE ordering_modifier_presentation_overrides SET included_choice_count=${allowance} WHERE item_id=${itemId} AND group_id=${groupId}`;
          const order = await create({ quantity: 2, modifierSelections: { [groupId]: [optionId] }, modifierQuantities: { [optionId]: quantity } });
          const modifierTotal = 25 + Math.max(0, quantity - allowance) * 175;
          assert.equal(Number(order.subtotal_cents), 2 * (1200 + modifierTotal));
          const [snapshot] = await sql`SELECT SUM(m.quantity)::int AS quantity,SUM(m.quantity*m.unit_price_delta_cents)::int AS total FROM ordering_order_item_modifiers m JOIN ordering_order_items i ON i.id=m.order_item_id WHERE i.order_id=${order.id} AND m.selection_state IN ('selected','extra')`;
          assert.equal(Number(snapshot.quantity), quantity);
          assert.equal(Number(snapshot.total), modifierTotal);
          assert.equal((await submit(order.id)).order.status, "sent_to_kitchen");
        });
      }
      await check("declined allowance still charges one fee", async () => {
        const order = await create({ modifierSelections: { [groupId]: [optionId] }, modifierQuantities: { [optionId]: 3 }, modifierDeclines: [groupId] });
        assert.equal(Number(order.subtotal_cents), 1200 + 25 + 3 * 175);
        assert.equal((await submit(order.id)).order.status, "sent_to_kitchen");
      });
      for (const mutation of ["higher fee", "removed fee", "more included", "no included", "removed fee equals option price"] as const) {
        await check(`changed modifier rejects: ${mutation}`, async () => {
          if (mutation === "removed fee equals option price") await sql`UPDATE ordering_menu_variant_modifier_prices SET price_delta_cents=25 WHERE variant_id=${variantId} AND option_id=${optionId}`;
          const order = await create({ modifierSelections: { [groupId]: [optionId] }, modifierQuantities: { [optionId]: 3 } });
          if (mutation === "higher fee") await sql`UPDATE ordering_modifier_groups SET selection_charge_cents=50 WHERE id=${groupId}`;
          if (mutation === "removed fee" || mutation === "removed fee equals option price") await sql`UPDATE ordering_modifier_groups SET selection_charge_cents=0 WHERE id=${groupId}`;
          if (mutation === "more included") await sql`UPDATE ordering_modifier_presentation_overrides SET included_choice_count=2 WHERE item_id=${itemId} AND group_id=${groupId}`;
          if (mutation === "no included") await sql`UPDATE ordering_modifier_presentation_overrides SET included_choice_count=0 WHERE item_id=${itemId} AND group_id=${groupId}`;
          await assert.rejects(() => submit(order.id), (error: unknown) => error instanceof OrderConflictError && /modifier/i.test(error.message));
        });
      }
      await check("unchanged combo submits", async () => {
        const order = await create({ quantity: 2, comboId, comboSelections: { [comboGroupId]: [comboOptionId] } });
        assert.equal(Number(order.subtotal_cents), 2 * (1200 + 300 + 75));
        assert.equal((await submit(order.id)).order.status, "sent_to_kitchen");
      });
      for (const mutation of ["base price", "option price", "sold out", "inactive option", "inactive group", "inactive combo", "unlinked combo", "new required group"] as const) {
        await check(`changed combo rejects: ${mutation}`, async () => {
          const order = await create({ comboId, comboSelections: { [comboGroupId]: [comboOptionId] } });
          if (mutation === "base price") await sql`UPDATE ordering_combo_definitions SET base_price_delta_cents=400 WHERE id=${comboId}`;
          if (mutation === "option price") await sql`UPDATE ordering_combo_options SET price_delta_cents=100 WHERE id=${comboOptionId}`;
          if (mutation === "sold out") await sql`UPDATE ordering_combo_options SET available=FALSE WHERE id=${comboOptionId}`;
          if (mutation === "inactive option") await sql`UPDATE ordering_combo_options SET active=FALSE WHERE id=${comboOptionId}`;
          if (mutation === "inactive group") await sql`UPDATE ordering_combo_groups SET active=FALSE WHERE id=${comboGroupId}`;
          if (mutation === "inactive combo") await sql`UPDATE ordering_combo_definitions SET active=FALSE WHERE id=${comboId}`;
          if (mutation === "unlinked combo") await sql`UPDATE ordering_menu_item_combos SET active=FALSE WHERE item_id=${itemId} AND combo_id=${comboId}`;
          if (mutation === "new required group") await sql`INSERT INTO ordering_combo_groups(id,combo_id,name) VALUES(${randomUUID()},${comboId},'Audit required drink')`;
          await assert.rejects(() => submit(order.id), (error: unknown) => error instanceof OrderConflictError && /combo/i.test(error.message));
        });
      }
      await check("combo with no selected options still rechecks base price", async () => {
        await sql`UPDATE ordering_combo_groups SET min_selections=0 WHERE id=${comboGroupId}`;
        const order = await create({ comboId });
        assert.equal(Number(order.subtotal_cents), 1500);
        await sql`UPDATE ordering_combo_definitions SET base_price_delta_cents=400 WHERE id=${comboId}`;
        await assert.rejects(() => submit(order.id), (error: unknown) => error instanceof OrderConflictError && /combo/i.test(error.message));
      });
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  console.log(JSON.stringify({ checks, failures }, null, 2));
  assert.equal(failures.length, 0, failures.join("\n"));
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
