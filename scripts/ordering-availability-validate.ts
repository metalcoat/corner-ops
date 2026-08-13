import assert from "node:assert/strict";
import { isWithinInclusiveWindow } from "../src/lib/ordering-availability";

const cutoff = 21 * 60 + 30;
assert.equal(isWithinInclusiveWindow(9 * 60, cutoff, 21 * 60 + 29), true);
assert.equal(isWithinInclusiveWindow(9 * 60, cutoff, 21 * 60 + 30), true);
assert.equal(isWithinInclusiveWindow(9 * 60, cutoff, 21 * 60 + 31), false);

assert.equal(isWithinInclusiveWindow(22 * 60, 2 * 60, 23 * 60), true);
assert.equal(isWithinInclusiveWindow(22 * 60, 2 * 60, 2 * 60), true);
assert.equal(isWithinInclusiveWindow(22 * 60, 2 * 60, 3 * 60), false);

console.log("Ordering availability validation passed.");
