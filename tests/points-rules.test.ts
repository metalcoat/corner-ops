import assert from "node:assert/strict";
import test from "node:test";
import { pointsBonusApplies, pointsEarnRate, pointsForCents, pointsRewardDiscount, pointsRewardFitsCart, type PointsSettings } from "../src/lib/ordering-points-rules";

const settings: PointsSettings = { active: true, onlineRate: 1.1, storeRate: 1, staffPhoneOrdersEarn: true, bonusMultiplier: 2, bonusDays: [1, 2], bonusStart: "10:30", bonusEnd: "14:00", expiryMonths: 12 };
const order = { source: "pos", orderOrigin: "pos", paymentStatus: "unpaid", callerPhone: "", customerPhones: ["+13155550101"] };

test("points: online earns 1.1 per $1, in store 1 per $1, nothing when switched off", () => {
  assert.equal(pointsEarnRate({ ...order, source: "web", orderOrigin: "web" }, settings), 1.1);
  assert.equal(pointsEarnRate(order, settings), 1);
  assert.equal(pointsEarnRate(order, { ...settings, active: false }), 0);
});

test("points: AI phone orders earn only for the account that owns the caller ID", () => {
  const phone = { ...order, source: "ai_phone", orderOrigin: "ai" };
  assert.equal(pointsEarnRate({ ...phone, callerPhone: "+1 (315) 555-0101" }, settings), 1);
  assert.equal(pointsEarnRate({ ...phone, callerPhone: "+13155550199" }, settings), 0);
  assert.equal(pointsEarnRate({ ...phone, callerPhone: "" }, settings), 0);
  assert.equal(pointsEarnRate({ ...phone, callerPhone: "anonymous" }, settings), 0);
});

test("points: staff-taken phone orders earn only once paid, and can be switched off", () => {
  const phone = { ...order, orderOrigin: "phone" };
  assert.equal(pointsEarnRate(phone, settings), 0);
  assert.equal(pointsEarnRate({ ...phone, paymentStatus: "paid" }, settings), 1);
  assert.equal(pointsEarnRate({ ...phone, paymentStatus: "paid" }, { ...settings, staffPhoneOrdersEarn: false }), 0);
});

test("points: lunch bonus by the time the order is for, in store time", () => {
  assert.equal(pointsBonusApplies(new Date("2026-11-02T16:00:00Z"), settings), true); // Mon 11:00 ET
  assert.equal(pointsBonusApplies(new Date("2026-11-03T18:59:00Z"), settings), true); // Tue 1:59 PM ET
  assert.equal(pointsBonusApplies(new Date("2026-11-03T19:00:00Z"), settings), false); // Tue 2:00 PM ET
  assert.equal(pointsBonusApplies(new Date("2026-11-02T15:29:00Z"), settings), false); // Mon 10:29 ET
  assert.equal(pointsBonusApplies(new Date("2026-11-04T16:00:00Z"), settings), false); // Wed
});

test("points: amounts round down to a tenth", () => {
  assert.equal(pointsForCents(2000, 1.1), 22);
  assert.equal(pointsForCents(2000, 1.1, 2), 44);
  assert.equal(pointsForCents(1999, 1), 19.9);
  assert.equal(pointsForCents(0, 1.1), 0);
});

const line = { itemId: "fries", variantId: null, unitPriceCents: 300, lineTotalCents: 600, otherDiscountCents: 0, modifiers: [] as Array<{ optionId: string; unitPriceDeltaCents: number; pizzaToppingAmount: string | null }> };

test("points: rewards take off one item, one regular add-on, or the upgrade difference", () => {
  assert.equal(pointsRewardDiscount({ kind: "item", itemIds: ["fries"], variantIds: [], optionIds: [], fromVariantPriceCents: null }, line), 300);
  assert.equal(pointsRewardDiscount({ kind: "item", itemIds: ["tots"], variantIds: [], optionIds: [], fromVariantPriceCents: null }, line), 0);
  const pizza = { ...line, itemId: "pizza", variantId: "small", unitPriceCents: 1000, lineTotalCents: 1450, modifiers: [{ optionId: "pepperoni", unitPriceDeltaCents: 300, pizzaToppingAmount: "extra" }] };
  assert.equal(pointsRewardDiscount({ kind: "item", itemIds: ["pizza"], variantIds: ["small"], optionIds: [], fromVariantPriceCents: null }, pizza), 1000);
  assert.equal(pointsRewardDiscount({ kind: "item", itemIds: ["pizza"], variantIds: ["jumbo"], optionIds: [], fromVariantPriceCents: null }, pizza), 0);
  assert.equal(pointsRewardDiscount({ kind: "modifier", itemIds: [], variantIds: [], optionIds: ["pepperoni"], fromVariantPriceCents: null }, pizza), 150);
  const thick = { ...line, itemId: "pizza", variantId: "thick", unitPriceCents: 1650, lineTotalCents: 1650 };
  assert.equal(pointsRewardDiscount({ kind: "upgrade", itemIds: [], variantIds: ["thick"], optionIds: [], fromVariantPriceCents: 1550 }, thick), 100);
  assert.equal(pointsRewardDiscount({ kind: "item", itemIds: ["fries"], variantIds: [], optionIds: [], fromVariantPriceCents: null }, { ...line, lineTotalCents: 300, otherDiscountCents: 200 }), 100);
});

test("points: reward buttons only for what's in the cart", () => {
  const cart = [{ itemId: "pizza", variantId: "thick", optionIds: ["pepperoni"] }];
  assert.equal(pointsRewardFitsCart({ kind: "upgrade", itemIds: [], variantIds: ["thick"], optionIds: [] }, cart), true);
  assert.equal(pointsRewardFitsCart({ kind: "modifier", itemIds: [], variantIds: [], optionIds: ["bacon"] }, cart), false);
  assert.equal(pointsRewardFitsCart({ kind: "item", itemIds: ["fries"], variantIds: [], optionIds: [] }, cart), false);
});
