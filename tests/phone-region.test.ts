import test from "node:test";
import assert from "node:assert/strict";
import { usOrCanadaMobile } from "../src/lib/phone-region.js";

test("sign-in texts go only to US and Canadian numbers", () => {
  assert.equal(usOrCanadaMobile("+13153932271"), true);
  assert.equal(usOrCanadaMobile("+16135550100"), true); // Ottawa
  assert.equal(usOrCanadaMobile("+18765550100"), false); // Jamaica
  assert.equal(usOrCanadaMobile("+18095550100"), false); // Dominican Republic
  assert.equal(usOrCanadaMobile("+11235550100"), false);
  assert.equal(usOrCanadaMobile("3153932271"), false);
});
