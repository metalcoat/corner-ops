import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

test("Tiki clock-out closes every stale open punch for the employee", () => {
  const tiki = source("src/lib/tiki-timeclock.ts");

  assert.match(
    tiki,
    /FROM time_entries[\s\S]*WHERE business = 'Tiki'[\s\S]*AND employee_id = \$\{employee\.id\}::uuid[\s\S]*AND clock_out IS NULL[\s\S]*ORDER BY clock_in DESC, created_at DESC, id DESC/,
  );
  assert.doesNotMatch(
    tiki,
    /FROM time_entries[\s\S]*AND clock_out IS NULL[\s\S]*ORDER BY clock_in DESC, created_at DESC, id DESC\s*LIMIT 1/,
  );
  assert.match(
    tiki,
    /UPDATE time_entries SET[\s\S]*WHERE business = 'Tiki'[\s\S]*AND employee_id = \$\{employee\.id\}::uuid[\s\S]*AND clock_out IS NULL[\s\S]*RETURNING id, clock_in, clock_out, status/,
  );
  assert.match(tiki, /Automatically closed stale duplicate open punch during clock-out\./);
  assert.match(tiki, /const entry = result\.find\(\(row\) => row\.id === existing\.id\)/);
});

test("payroll correction only reports success after the punch row is returned", () => {
  const correction = source("src/lib/payroll-punch-correction.ts");
  const route = source("src/app/api/payroll-control/route.ts");

  assert.match(route, /import \{ correctPunch \} from "@\/lib\/payroll-punch-correction"/);
  assert.match(
    correction,
    /UPDATE rezku_shifts SET[\s\S]*WHERE id = \$\{input\.sourceId\}[\s\S]*RETURNING \*/,
  );
  assert.match(
    correction,
    /UPDATE time_entries SET[\s\S]*WHERE id = \$\{input\.sourceId\} AND business = \$\{input\.business\}[\s\S]*RETURNING \*/,
  );
  assert.match(correction, /if \(!after\) \{[\s\S]*Shift correction was not saved\. Reload payroll and try again\./);
  assert.match(correction, /INSERT INTO time_entry_adjustments/);
});

test("owner Tiki corrections atomically update the punch, reconcile live clock state, and audit", () => {
  const route = source("src/app/api/tiki-time-corrections/route.ts");

  assert.match(route, /async function correctTikiPunchAtomically/);
  assert.match(route, /WITH selected_before AS MATERIALIZED/);
  assert.match(route, /updated_selected AS \([\s\S]*UPDATE time_entries AS target/);
  assert.match(
    route,
    /stale_before AS MATERIALIZED \([\s\S]*clock_out IS NULL[\s\S]*stale\.clock_in <= corrected\.clock_out/,
  );
  assert.match(
    route,
    /updated_stale AS \([\s\S]*clock_out = target\.clock_in[\s\S]*status = 'Corrected'/,
  );
  assert.match(route, /audit_insert AS \([\s\S]*INSERT INTO time_entry_adjustments/);
  assert.match(route, /staleOpenPunchesResolved/);
  assert.match(route, /return Response\.json\(await correctTikiPunchAtomically\(/);
});
