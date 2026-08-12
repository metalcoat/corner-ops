#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Pizza topping validation requires local PostgreSQL.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

async function main() {
  const [{ getSql }, { orderingMenuWithVariants }, { createDraftOrderWithVariants }, topping, lineFormat] = await Promise.all([
    import("../src/lib/db"), import("../src/lib/ordering-menu-variants"), import("../src/lib/ordering-orders-with-variants"), import("../src/lib/ordering-pizza-toppings"), import("../src/lib/ordering-line-format"),
  ]);
  const menu = await orderingMenuWithVariants("Corner Deli");
  const pizza = menu.flatMap((category) => category.items).find((item) => item.name === "Pizza");
  if (!pizza) throw new Error("Imported Pizza item not found.");
  const variant = pizza.variants.find((candidate) => candidate.name === 'Regular 14"');
  const group = pizza.modifiers.find((candidate) => candidate.presentationBehavior === "pizza_topping");
  const pepperoni = group?.options.find((option) => option.name === "Pepperoni");
  const mushrooms = group?.options.find((option) => option.name === "Mushrooms");
  if (!variant || !group || !pepperoni || !mushrooms) throw new Error("Imported Pizza topping fixtures are incomplete.");
  const configuredPrice = variant.modifierPrices.find((price) => price.optionId === pepperoni.id)?.priceDeltaCents;
  if (!configuredPrice) throw new Error("Imported Pepperoni price was not found.");
  const modifierSelections = Object.fromEntries(pizza.modifiers.filter((candidate) => candidate.presentationBehavior !== "pizza_topping").map((candidate) => [candidate.id, candidate.options.filter((option) => option.defaultSelected).map((option) => option.id)]));
  const cases = [
    ["wholeRegular", [{ modifierOptionId: pepperoni.id, portion: "whole", amount: "regular" }], configuredPrice],
    ["leftRegular", [{ modifierOptionId: pepperoni.id, portion: "left_half", amount: "regular" }], configuredPrice / 2],
    ["rightRegular", [{ modifierOptionId: pepperoni.id, portion: "right_half", amount: "regular" }], configuredPrice / 2],
    ["wholeExtra", [{ modifierOptionId: pepperoni.id, portion: "whole", amount: "extra" }], configuredPrice * 2],
    ["leftExtra", [{ modifierOptionId: pepperoni.id, portion: "left_half", amount: "extra" }], configuredPrice],
    ["rightExtra", [{ modifierOptionId: pepperoni.id, portion: "right_half", amount: "extra" }], configuredPrice],
    ["bothRegular", [{ modifierOptionId: pepperoni.id, portion: "left_half", amount: "regular" }, { modifierOptionId: pepperoni.id, portion: "right_half", amount: "regular" }], configuredPrice],
    ["bothExtra", [{ modifierOptionId: pepperoni.id, portion: "left_half", amount: "extra" }, { modifierOptionId: pepperoni.id, portion: "right_half", amount: "extra" }], configuredPrice * 2],
    ["mixedAmounts", [{ modifierOptionId: pepperoni.id, portion: "left_half", amount: "regular" }, { modifierOptionId: pepperoni.id, portion: "right_half", amount: "extra" }], configuredPrice + configuredPrice / 2],
    ["oppositeToppings", [{ modifierOptionId: pepperoni.id, portion: "left_half", amount: "regular" }, { modifierOptionId: mushrooms.id, portion: "right_half", amount: "extra" }], configuredPrice + configuredPrice / 2],
  ] as const;
  const results: Record<string, unknown> = {};
  const sql = getSql();
  const createdOrderIds: string[] = [];
  try {
    for (const [label, pizzaToppings, expected] of cases) {
      const order = await createDraftOrderWithVariants({ business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "pizza-topping-test", items: [{ itemId: pizza.id, variantId: variant.id, modifierSelections, pizzaToppings: pizzaToppings.map((value) => ({ ...value })) }] });
      createdOrderIds.push(String(order.id));
      const item = (await sql`SELECT id,modifier_total_cents FROM ordering_order_items WHERE order_id=${order.id}`)[0];
      if (!item) throw new Error(`${label} did not persist an order item for order ${String(order.id)}.`);
      const snapshots = await sql`SELECT option_id,option_name_snapshot,pizza_topping_portion,pizza_topping_amount,unit_price_delta_cents,quantity FROM ordering_order_item_modifiers WHERE order_item_id=${item.id} AND pizza_topping_portion IS NOT NULL ORDER BY created_at,id`;
      if (Number(item.modifier_total_cents) !== expected) throw new Error(`${label} charged ${item.modifier_total_cents}; expected ${expected}.`);
      if (label === "bothRegular" && (snapshots.length !== 1 || snapshots[0].pizza_topping_portion !== "whole" || snapshots[0].pizza_topping_amount !== "regular")) throw new Error("Equal regular halves did not normalize.");
      if (label === "bothExtra" && (snapshots.length !== 1 || snapshots[0].pizza_topping_portion !== "whole" || snapshots[0].pizza_topping_amount !== "extra")) throw new Error("Equal extra halves did not normalize.");
      if (label === "mixedAmounts" && snapshots.length !== 2) throw new Error("Differing half amounts were incorrectly normalized.");
      if (snapshots.some((snapshot) => lineFormat.formatOrderModifier(snapshot as { option_name_snapshot: string; quantity: number; selection_state: string; pizza_topping_portion: "whole" | "left_half" | "right_half"; pizza_topping_amount: "regular" | "extra" }).includes("2×"))) throw new Error("Pizza formatter exposed numeric intensity.");
      results[label] = { chargedCents: Number(item.modifier_total_cents), snapshots };
    }
  } finally {
    for (const orderId of createdOrderIds) await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
  }
  if (topping.pizzaToppingPriceCents(101, "left_half", "regular") !== 51) throw new Error("Odd-cent half pricing must round up.");
  if (lineFormat.formatOrderModifier({ option_name_snapshot: "Pepperoni", quantity: 1, selection_state: "selected", pizza_topping_portion: "left_half", pizza_topping_amount: "extra" }, "ticket") !== "LEFT HALF EXTRA PEPPERONI") throw new Error("Ticket formatter contract failed.");
  console.log(JSON.stringify({ configuredPriceCents: configuredPrice, oddCentHalfRoundsUp: true, sharedCustomerAndKitchenFormatter: true, cases: results }, null, 2));
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
