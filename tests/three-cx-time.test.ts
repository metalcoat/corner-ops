import assert from "node:assert/strict";
import test from "node:test";
import { parseThreeCxTimestamp } from "../src/lib/three-cx-time";

test("3CX naive CDR timestamp is interpreted as UTC, not server or Eastern local time", () => {
  assert.equal(parseThreeCxTimestamp("2026/08/24 00:51:57")?.toISOString(), "2026-08-24T00:51:57.000Z");
});

test("3CX timestamp with an explicit offset preserves that instant", () => {
  assert.equal(parseThreeCxTimestamp("2026-08-24T00:51:57-04:00")?.toISOString(), "2026-08-24T04:51:57.000Z");
});
