import assert from "node:assert/strict";
import test from "node:test";
import { changedTicketLines, describeSnapshot, lineSnapshot, sameLine, savedLineConfiguration, type SavedLine } from "../src/lib/ordering-line-edit-rules";

const pizza = (toppings: string[], extra: Partial<SavedLine> = {}): SavedLine => ({
  item_id: "item-pizza", variant_id: "jumbo-thin", item_name_snapshot: "Pizza", variant_name_snapshot: "Jumbo Thin 16\"", quantity: 1,
  modifiers: toppings.map((name) => ({ group_id: "toppings", option_id: `opt-${name}`, option_name_snapshot: name, selection_state: "selected", pizza_topping_portion: "whole", pizza_topping_amount: "regular" })),
  ...extra,
});

test("a saved line opens the item screen with the choices it was rung with", () => {
  const config = savedLineConfiguration({
    item_id: "wings", variant_id: "ten", item_name_snapshot: "Wings", quantity: 3, cancelled_quantity: 1, special_instructions: "crispy",
    modifiers: [
      { group_id: "sauce", option_id: "bbq", option_name_snapshot: "Open Pit BBQ", selection_state: "selected", quantity: 1, amount: "heavy" },
      { group_id: "dip", option_id: "ranch", option_name_snapshot: "Ranch", selection_state: "selected", quantity: 1 },
      { group_id: "dip", option_id: "ranch", option_name_snapshot: "Ranch", selection_state: "extra", quantity: 2 },
      { group_id: "celery", option_id: "celery", option_name_snapshot: "Celery", selection_state: "removed" },
      { group_id: "side", option_id: "fries", option_name_snapshot: "Included choice", selection_state: "declined_included" },
      { group_id: "toppings", option_id: "sausage", option_name_snapshot: "Sausage", selection_state: "selected", pizza_topping_portion: "left_half", pizza_topping_amount: "extra" },
    ],
    combo_selections: [{ combo_id: "meal", group_id: "drink", option_id: "coke" }],
  });
  assert.equal(config.quantity, 2);
  assert.equal(config.variantId, "ten");
  assert.deepEqual(config.modifierSelections, { sauce: ["bbq"], dip: ["ranch"] });
  assert.deepEqual(config.modifierQuantities, { bbq: 1, ranch: 3 });
  assert.deepEqual(config.modifierAmounts, { bbq: "heavy" });
  assert.deepEqual(config.modifierDeclines, ["side"]);
  assert.deepEqual(config.pizzaToppings, [{ modifierOptionId: "sausage", portion: "left_half", amount: "extra" }]);
  assert.equal(config.comboId, "meal");
  assert.deepEqual(config.comboSelections, { drink: ["coke"] });
  assert.equal(config.specialInstructions, "crispy");
});

test("the kitchen's CHANGED ticket shows only what changed", () => {
  const lines = changedTicketLines(lineSnapshot(pizza(["Pepperoni", "Onions"])), lineSnapshot(pizza(["Sausage", "Onions"])));
  assert.deepEqual(lines, ["** CHANGED ** 1x PIZZA (JUMBO THIN 16\")", "  - PEPPERONI", "  + SAUSAGE"]);
});

test("size, quantity and note changes are spelled out", () => {
  const before = lineSnapshot(pizza(["Pepperoni"], { special_instructions: "well done" }));
  const after = lineSnapshot(pizza(["Pepperoni"], { variant_name_snapshot: "Jumbo Thick", quantity: 2 }));
  assert.deepEqual(changedTicketLines(before, after), ["** CHANGED ** 2x PIZZA", "  SIZE: JUMBO THIN 16\" -> JUMBO THICK", "  QTY: 1 -> 2", "  NOTE REMOVED"]);
});

test("defaults that don't print are not a change; removing one is", () => {
  const withDefault = (state: string, print: boolean): SavedLine => ({ item_id: "sub", item_name_snapshot: "Italian Sub", quantity: 1, modifiers: [{ group_id: "veg", option_id: "lettuce", option_name_snapshot: "Lettuce", selection_state: state, print_on_ticket: print }] });
  assert.deepEqual(lineSnapshot(withDefault("selected", false)).modifiers, []);
  assert.deepEqual(changedTicketLines(lineSnapshot(withDefault("selected", false)), lineSnapshot(withDefault("removed", true))), ["** CHANGED ** 1x ITALIAN SUB", "  + NO LETTUCE"]);
  assert.ok(sameLine(lineSnapshot(pizza(["Onions", "Ham"])), lineSnapshot(pizza(["Ham", "Onions"]))));
});

test("half-pizza toppings and extra amounts keep their wording, by menu name", () => {
  const line: SavedLine = { item_id: "p", item_name_snapshot: "Pizza", quantity: 1, modifiers: [{ group_id: "t", option_id: "b", option_name_snapshot: "Bacon", option_print_name_snapshot: "BAC", selection_state: "selected", pizza_topping_portion: "right_half", pizza_topping_amount: "double_extra" }] };
  assert.deepEqual(lineSnapshot(line).modifiers, ["RIGHT 2X EXTRA BACON"]);
  assert.equal(describeSnapshot(lineSnapshot(line)), "1x PIZZA: RIGHT 2X EXTRA BACON");
});
