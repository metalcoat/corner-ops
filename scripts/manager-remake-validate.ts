import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateRemakeInput } from "../src/lib/ordering-remakes";
import { storeLocalTimeToIso } from "../src/lib/ordering-remake-time";

const originalOrderId = randomUUID();
const orderItemId = randomUUID();
const clientMutationId = randomUUID();
const base = {
  originalOrderId, clientMutationId, items: [{ orderItemId, quantity: 1 }],
  specialItem: "", reason: "Overcooked", serviceType: "pickup",
  customerName: "Test Customer", phone: "3155550123", address: "", unit: "",
  deliveryNotes: "", scheduledFor: null,
};

assert.equal(validateRemakeInput(base).items[0].quantity, 1);
assert.equal(validateRemakeInput({ ...base, items: [], specialItem: "Make 4 mozzarella sticks" }).specialItem, "Make 4 mozzarella sticks");
assert.throws(() => validateRemakeInput({ ...base, items: [], specialItem: "" }), /Choose at least one item/);
assert.throws(() => validateRemakeInput({ ...base, items: [{ orderItemId, quantity: 0 }] }), /Choose valid remake quantities/);
assert.throws(() => validateRemakeInput({ ...base, items: [...base.items, ...base.items] }), /Choose valid remake quantities/);
assert.throws(() => validateRemakeInput({ ...base, serviceType: "delivery" }), /complete delivery address/);
assert.throws(() => validateRemakeInput({ ...base, scheduledFor: new Date(Date.now() - 60_000).toISOString() }), /Choose a pickup or delivery time/);
assert.equal(validateRemakeInput({ ...base, serviceType: "delivery", address: "12 Main St, Ogdensburg, NY" }).serviceType, "delivery");
assert.equal(storeLocalTimeToIso("2026-07-01T12:30"), "2026-07-01T16:30:00.000Z");
assert.equal(storeLocalTimeToIso("2026-12-01T12:30"), "2026-12-01T17:30:00.000Z");
assert.throws(() => storeLocalTimeToIso("2026-03-08T02:30"), /daylight saving time/);
assert.throws(() => storeLocalTimeToIso("2026-11-01T01:30"), /daylight saving time/);
console.log("Manager remake input validation passed.");
