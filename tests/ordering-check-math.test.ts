import assert from "node:assert/strict";
import test from "node:test";
import { splitShared } from "../src/lib/ordering-check-math";

test("tax and fees split across checks add back up to the shared amount", () => {
  for (const [cents, count] of [[1000, 3], [7, 2], [0, 4], [-5, 3], [999, 1]] as const) {
    const shares = splitShared(cents, count);
    assert.equal(shares.length, count);
    assert.equal(shares.reduce((a, b) => a + b, 0), cents);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
  }
});
