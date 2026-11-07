import assert from "node:assert/strict";
import test from "node:test";
import { parseCustomItems } from "../src/lib/custom-item-rules";

test("custom items: valid lines, $0 allowed, quantity defaults to 1", () => {
  assert.deepEqual(parseCustomItems([{ name: " Extra napkins ", priceCents: 0, note: " bag " }]), [{ name: "Extra napkins", priceCents: 0, quantity: 1, note: "bag" }]);
  assert.deepEqual(parseCustomItems(undefined), []);
});

test("custom items: bad input is refused", () => {
  assert.throws(() => parseCustomItems([{ name: "", priceCents: 100 }]), /name/);
  assert.throws(() => parseCustomItems([{ name: "x", priceCents: -1 }]), /price/);
  assert.throws(() => parseCustomItems([{ name: "x", priceCents: 1.5 }]), /price/);
  assert.throws(() => parseCustomItems([{ name: "x", priceCents: 100, quantity: 0 }]), /quantity/);
  assert.throws(() => parseCustomItems("x"), /not valid/);
});
