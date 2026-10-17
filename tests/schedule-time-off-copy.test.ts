import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("taking someone off a shift for time off remembers them, and giving it back clears it", () => {
  const actions = source("src/lib/schedule-actions.ts");
  assert.match(actions, /currentEmployee && \(employeeId !== currentEmployee \|\| status === "Cancelled"\)/);
  assert.match(actions, /if \(off\.length\) timeOffEmployeeId = currentEmployee/);
  assert.match(actions, /employeeId === timeOffEmployeeId && status !== "Cancelled"\) timeOffEmployeeId = null/);
  assert.match(actions, /time_off_employee_id = \$\{timeOffEmployeeId\}/);
  assert.match(source("src/lib/workforce.ts"), /ADD COLUMN IF NOT EXISTS time_off_employee_id UUID/);
  assert.match(source("db/migrations/0012_schedule_time_off_employee.sql"), /ADD COLUMN IF NOT EXISTS time_off_employee_id uuid/);
});

test("copying a week gives a day-off shift back to the regular employee instead of copying the day off", () => {
  const copy = source("src/lib/schedule-week-copy.ts");
  assert.match(copy, /COALESCE\(s\.time_off_employee_id, s\.employee_id\) AS regular_employee_id/);
  // Cancelled only because of the day off: still copied.
  assert.equal(copy.match(/\(s\.status <> 'Cancelled' OR s\.time_off_employee_id IS NOT NULL\)/g)?.length, 2);
  assert.match(copy, /\) THEN regular_employee_id/);
  // Still left open when the regular employee has approved time off in the target week.
  assert.match(copy, /t\.employee_id = source_shifts\.regular_employee_id[\s\S]*t\.status = 'Approved'/);
});

test("managers can delete a day off from the time-off list and the schedule grid", () => {
  const workforce = source("src/lib/workforce.ts");
  assert.match(workforce, /export async function deleteTimeOff/);
  assert.match(workforce, /status = 'Cancelled'[\s\S]*WHERE id = \$\{input\.id\} AND business = \$\{input\.business\} AND status <> 'Cancelled'/);
  assert.match(source("src/app/api/workforce/route.ts"), /action === "time-off-delete"[\s\S]*deleteTimeOff\(/);
  const page = source("src/app/ops/workforce/page.tsx");
  assert.match(page, /action: "time-off-delete"/);
  assert.match(page, /request\.status !== "Cancelled"/);
  assert.match(source("src/app/ops/workforce/schedule-board.tsx"), /onClick=\{\(\) => void deleteTimeOff\(approvedDayOff\)\}/);
});
