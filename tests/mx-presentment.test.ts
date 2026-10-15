import test from "node:test";
import assert from "node:assert/strict";
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
