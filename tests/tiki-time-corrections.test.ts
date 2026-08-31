import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

test("owner punch corrections do not require a typed reason", () => {
  const correction = source("src/lib/payroll-punch-correction.ts");
  assert.match(correction, /reason\?: string/);
  assert.match(correction, /clean\(input\.reason, 1000\) \|\| "Owner time correction"/);
  assert.doesNotMatch(correction, /A correction reason is required/);
});

test("Tiki correction screen can use a mistaken IN as the prior OUT", () => {
  const route = source("src/app/api/tiki-time-corrections/route.ts");
  const page = source("src/app/ops/tiki-time-corrections/page.tsx");

  assert.match(route, /action === "use-in-as-prior-out"/);
  assert.match(route, /clock_out = \$\{mistakenClockInIso\}/);
  assert.match(route, /clock_out = clock_in/);
  assert.match(route, /INSERT INTO time_entry_adjustments/);
  assert.match(page, /This IN was prior OUT/);
  assert.match(page, /Reason <small>Optional<\/small>/);
  assert.match(page, /Leave blank for Owner time correction/);
});
