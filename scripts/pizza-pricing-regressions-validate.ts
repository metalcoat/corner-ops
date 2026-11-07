import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.VALIDATION_DATABASE_URL || process.env.ORDERING_AUDIT_DATABASE !== "1") throw new Error("An explicitly isolated audit database is required.");
process.env.DATABASE_URL = process.env.VALIDATION_DATABASE_URL;
process.env.DATABASE_DRIVER = "postgres";
process.env.VALIDATION_DISABLE_OUTBOUND = "1";

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { orderingMenuWithVariants } = await import("../src/lib/ordering-menu-variants");
  const { createDraftOrderWithVariants, appendConfiguredOrderItemsWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { submitDraftOrder } = await import("../src/lib/ordering-order-lifecycle");
  const sql = getSql(), menu = await orderingMenuWithVariants("Corner Deli");
  const orders: string[] = [], itemId = randomUUID(), variantId = randomUUID(), groupId = randomUUID(), optionId = randomUUID();
  let checks = 0;
  const create = async (items: Parameters<typeof createDraftOrderWithVariants>[0]["items"]) => {
    const order = await createDraftOrderWithVariants({ business: "Corner Deli", source: "web", serviceType: "pickup", createdBy: "pizza-pricing-regressions", items });
    orders.push(order.id); return order;
  };
  try {
    for (const item of menu.flatMap((category) => category.items).filter((candidate) => candidate.modifiers.some((group) => group.presentationBehavior === "pizza_topping"))) {
      const group = item.modifiers.find((candidate) => candidate.presentationBehavior === "pizza_topping")!;
      const modifierSelections = Object.fromEntries(item.modifiers.filter((candidate) => candidate.presentationBehavior !== "pizza_topping").map((candidate) => [candidate.id, candidate.options.filter((option) => option.defaultSelected).map((option) => option.id)]));
      for (const variant of item.variants.filter((candidate) => candidate.available)) {
        const defaultCharges = item.modifiers.filter((candidate) => candidate.presentationBehavior !== "pizza_topping")
          .flatMap((candidate) => candidate.options.filter((option) => option.defaultSelected))
          .reduce((sum, option) => sum + (variant.modifierPrices.find((price) => price.optionId === option.id)?.priceDeltaCents ?? option.priceDeltaCents), 0);
        for (const name of ["Pepperoni", "Chicken"]) {
          const option = group.options.find((candidate) => candidate.name === name)!;
          const base = variant.modifierPrices.find((price) => price.optionId === option.id)!.priceDeltaCents;
          for (const [amount, multiplier] of [["regular",1], ["extra",2], ["double_extra",3], ["triple_extra",4]] as const) {
            for (const portion of ["whole", "left_half", "right_half"] as const) {
              const order = await create([{ itemId: item.id, variantId: variant.id, quantity: 2, modifierSelections, pizzaToppings: [{ modifierOptionId: option.id, portion, amount }] }]);
              const charged = portion === "whole" ? base * multiplier : Math.ceil(base * multiplier / 2);
              assert.equal(order.subtotal_cents, 2 * (variant.basePriceCents + defaultCharges + charged), `${item.name} ${variant.name} ${name} ${portion} ${amount}`);
              checks++;
            }
          }
        }
        const option = group.options[0];
        await assert.rejects(() => create([{ itemId: item.id, variantId: variant.id, modifierSelections, pizzaToppings: [{ modifierOptionId: option.id, portion: "whole", amount: "regular" }, { modifierOptionId: option.id, portion: "left_half", amount: "extra" }] }]), /one topping amount/);
        checks++;
      }
      await assert.rejects(() => create([{ itemId: item.id, modifierSelections }]), /Choose a size/);
      await assert.rejects(() => create([{ itemId: item.id, variantId: randomUUID(), modifierSelections }]), /not available/);
      checks += 2;
    }

    // Isolated fixtures prove quantity allowances remain correct with size prices.
    const categoryId = menu[0].id;
    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) VALUES(${itemId},'Corner Deli',${categoryId},${`Audit meal ${itemId}`},1000)`;
    await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents) VALUES(${variantId},${itemId},'Audit size',1200)`;
    await sql`INSERT INTO ordering_modifier_groups(id,business,name,max_selections,allow_option_quantity) VALUES(${groupId},'Corner Deli',${`Audit dressing ${groupId}`},1,TRUE)`;
    await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents) VALUES(${optionId},${groupId},'Audit sauce',100)`;
    await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id) VALUES(${randomUUID()},${itemId},${groupId})`;
    await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,included_choice_count) VALUES(${itemId},${groupId},1)`;
    await sql`INSERT INTO ordering_menu_variant_modifier_prices(id,variant_id,option_id,price_delta_cents) VALUES(${randomUUID()},${variantId},${optionId},175)`;
    for (const quantity of [1,2,3,99]) {
      const configured = { itemId, variantId, modifierSelections: { [groupId]: [optionId] }, modifierQuantities: { [optionId]: quantity } };
      const order = await create([configured]);
      assert.equal(order.subtotal_cents, 1200 + (quantity - 1) * 175);
      const [stored] = await sql`SELECT SUM(modifier.quantity)::int quantity,SUM(modifier.quantity*modifier.unit_price_delta_cents)::int charged FROM ordering_order_item_modifiers modifier JOIN ordering_order_items item ON item.id=modifier.order_item_id WHERE item.order_id=${order.id}`;
      assert.equal(stored.quantity, quantity); assert.equal(stored.charged, (quantity - 1) * 175);
      const empty = await create([]);
      await appendConfiguredOrderItemsWithVariants(empty.id, "Corner Deli", [configured]);
      assert.equal((await sql`SELECT subtotal_cents FROM ordering_orders WHERE id=${empty.id}`)[0].subtotal_cents, order.subtotal_cents);
      await sql`UPDATE ordering_orders SET first_name_snapshot='Audit',phone_snapshot='+13155550199' WHERE id=${order.id}`;
      const sent = await submitDraftOrder(order.id, "Corner Deli", { id: "audit", name: "Audit", type: "employee", role: "manager" }, { approved: true, reason: "Isolated pricing validation" });
      assert.equal(sent.order.status, "sent_to_kitchen");
      checks += 3;
    }
    const decline = await create([{ itemId, variantId, modifierSelections: { [groupId]: [optionId] }, modifierQuantities: { [optionId]: 3 }, modifierDeclines: [groupId] }]);
    assert.equal(decline.subtotal_cents, 1200 + 3 * 175); checks++;
    for (const quantity of [0,-1,100,NaN]) {
      await assert.rejects(() => create([{ itemId, variantId, modifierSelections: { [groupId]: [optionId] }, modifierQuantities: { [optionId]: quantity } }]), /Invalid quantity/); checks++;
    }
    await sql`UPDATE ordering_menu_variant_modifier_prices SET available=FALSE WHERE variant_id=${variantId}`;
    await assert.rejects(() => create([{ itemId, variantId, modifierSelections: { [groupId]: [optionId] } }]), /not available/); checks++;
    await sql`UPDATE ordering_menu_item_variants SET available=FALSE WHERE id=${variantId}`;
    await assert.rejects(() => create([{ itemId, variantId }]), /unavailable/); checks++;
    await sql`UPDATE ordering_menu_item_variants SET active=FALSE WHERE id=${variantId}`;
    await assert.rejects(() => create([{ itemId, variantId }]), /does not support/); checks++;
    console.log(JSON.stringify({ checks, pizzaSizeToppingQuantityParity: true, includedUnitsAndVariantPrices: true, malformedAndUnavailableRejected: true }));
  } finally {
    for (const orderId of orders) {
      await sql`DELETE FROM ordering_print_jobs WHERE order_id=${orderId}`;
      await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
    }
    await sql`DELETE FROM ordering_menu_items WHERE id=${itemId}`;
    await sql`DELETE FROM ordering_modifier_groups WHERE id=${groupId}`;
  }
}
main().then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1)});
