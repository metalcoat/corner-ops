import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mxPresentment } from "../src/lib/mx-presentment.js";

test("keyed MX payments say whether the card was present", () => {
  assert.equal(mxPresentment("pos_keyed").cardPresent, true);
  assert.equal(mxPresentment("pos_keyed").posData.cardholderPresence, "Present");
  assert.equal(mxPresentment("online").cardPresent, false);
  assert.equal(mxPresentment("online").posData.cardholderPresence, "Ecom");
  assert.equal(mxPresentment("phone").cardPresent, false);
  assert.equal(mxPresentment("phone").posData.cardholderPresence, "Phone");
  for (const kind of ["pos_keyed", "online", "phone"] as const) assert.equal(mxPresentment(kind).posData.panCaptureMethod, "Manual");
});

test("sales are final and authorizations are preauthorizations (MX validation guide)", () => {
  assert.equal(mxPresentment("phone").authorizationIndicator, "Final");
  assert.equal(mxPresentment("phone").posData.transactionStatus, "Normal");
  assert.equal(mxPresentment("online", { authOnly: true }).authorizationIndicator, "Undefined");
  assert.equal(mxPresentment("online", { authOnly: true }).posData.transactionStatus, "Preauthorization");
});

test("phone orders send MX's MOTO posData (MX FTS review, Oct 2026)", () => {
  const phone = mxPresentment("phone");
  assert.equal(phone.authorizationIndicator, "Final");
  assert.deepEqual(phone.posData, {
    cardholderPresence: "Phone",
    deviceAttendance: "VoiceAru",
    deviceInputCapability: "KeyedOnly",
    deviceLocation: "VoiceAru",
    panCaptureMethod: "Manual",
    partialApprovalSupport: "NotSupported",
    transactionStatus: "Normal",
  });
});

// Saved cards are only used on phone and online orders, and say so to MX.
test("saved-card charges are sent as the phone or online order they were used on", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  assert.match(read("src/lib/mx-saved-cards.ts"), /\.\.\.mxPresentment\(input\.presentment\)/);
  assert.match(read("src/app/api/ordering/orders/[id]/payments/mx/route.ts"), /chargeSavedCard\(\{[^}]*presentment: "phone" \}\)/);
  assert.match(read("src/app/api/customer/orders/[id]/payments/mx/route.ts"), /chargeSavedCard\(\{[^}]*presentment: "online" \}\)/);
});
