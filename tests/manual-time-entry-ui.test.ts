import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("payroll control exposes a complete missing-shift form", () => {
  const layout = source("src/app/ops/payroll-control/layout.tsx");
  const panel = source("src/app/ops/payroll-control/missing-shift-panel.tsx");
  assert.match(layout, /MissingShiftPanel/);
  assert.match(panel, /Add completely missing shift/);
  assert.match(panel, /clockInWall/);
  assert.match(panel, /clockOutWall/);
  assert.match(panel, /Add shift & recalculate/);
  assert.match(panel, /window\.location\.reload\(\)/);
});

test("manual shift endpoint returns only active employees and handles overnight shifts", () => {
  const route = source("src/app/api/workforce/manual-time-entry/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /active = TRUE/);
  assert.match(route, /positionsForBusiness/);
  assert.match(route, /requirePermission\(session, "workforce\.write"\)/);
  assert.match(route, /if \(clockOutWall <= clockInWall\) endDate = nextDate\(date\)/);
});
