import test from "node:test";
import assert from "node:assert/strict";
import { normalizePizzaToppings, pizzaToppingPriceCents, setPizzaToppingAmount, type PizzaToppingAmount, type PizzaToppingPortion, type PizzaToppingSelection } from "../src/lib/ordering-pizza-toppings.js";

const topping = (portion: PizzaToppingPortion, amount: PizzaToppingAmount = "regular"): PizzaToppingSelection => ({ modifierOptionId: "pepperoni", portion, amount });
const price = (selections: PizzaToppingSelection[], cents = 200) => normalizePizzaToppings(selections).reduce((sum, entry) => sum + pizzaToppingPriceCents(cents, entry.portion, entry.amount), 0);

test("whole and equal halves have identical prices at every intensity, including odd cents", () => {
  for (const cents of [0, 1, 101, 200, 325]) {
    for (const amount of ["regular", "extra", "double_extra", "triple_extra"] as const) {
      assert.equal(price([topping("left_half", amount), topping("right_half", amount)], cents), price([topping("whole", amount)], cents));
    }
  }
  assert.equal(pizzaToppingPriceCents(101, "left_half", "regular"), 51);
});

test("editing a half of a whole topping preserves the other half and correct price", () => {
  let selected = setPizzaToppingAmount([topping("whole")], "pepperoni", "left_half", "extra");
  assert.deepEqual(selected, [topping("right_half"), topping("left_half", "extra")]);
  assert.equal(price(selected), 300);
  selected = setPizzaToppingAmount(selected, "pepperoni", "right_half", "extra");
  assert.deepEqual(selected, [topping("whole", "extra")]);
  assert.equal(price(selected), 400);
  selected = setPizzaToppingAmount(selected, "pepperoni", "left_half", null);
  assert.deepEqual(selected, [topping("right_half", "extra")]);
  assert.equal(price(selected), 200);
});

test("changes preserve unrelated toppings and whole removal clears both halves", () => {
  const mushrooms: PizzaToppingSelection = { modifierOptionId: "mushrooms", portion: "whole", amount: "regular" };
  const selected = [mushrooms, topping("left_half"), topping("right_half", "extra")];
  assert.deepEqual(setPizzaToppingAmount(selected, "pepperoni", "whole", null), [mushrooms]);
  assert.deepEqual(setPizzaToppingAmount(selected, "pepperoni", "whole", "triple_extra"), [mushrooms, topping("whole", "triple_extra")]);
});

test("malformed and overlapping customer topping payloads cannot alter pricing", () => {
  assert.deepEqual(normalizePizzaToppings([topping("whole"), topping("whole")]), [topping("whole")]);
  for (const selections of [
    [topping("whole"), topping("left_half")],
    [topping("left_half"), topping("left_half", "extra")],
    [{ ...topping("whole"), portion: "quarter" }],
    [{ ...topping("whole"), amount: "free" }],
    [null],
  ]) assert.throws(() => normalizePizzaToppings(selections as PizzaToppingSelection[]));
});
