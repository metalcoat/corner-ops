import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function source(path: string) {
  return readFileSync(join(root, path), "utf8");
}

test("Tiki primary save and receipt are atomic, with isolated stale cleanup", () => {
  const sql = source("db/migrations/0012_timeclock_idempotency.sql");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /prior\.response.*replayed/);
  assert.match(sql, /id = p_entry_id AND business = 'Tiki' AND employee_id = p_employee_id FOR UPDATE/);
  assert.match(sql, /AND id <> punch\.id AND clock_out IS NULL AND clock_in <= punch\.clock_in/);
  assert.match(sql, /EXCEPTION WHEN OTHERS THEN[\s\S]*Primary clock-out saved but stale duplicate cleanup failed/);
  assert.match(sql, /INSERT INTO public\.timeclock_punch_requests/);
});

test("uncertain punches are unmistakable and never falsely described as unsaved", () => {
  const tiki = source("src/lib/tiki-timeclock.ts");
  const route = source("src/app/api/timeclock/route.ts");
  const page = source("src/app/clock/page.tsx");
  const css = source("src/app/clock/clock.css");
  assert.match(tiki, /TikiPunchUnconfirmedError/);
  assert.match(route, /PUNCH_CLIENT_OUTDATED/);
  assert.doesNotMatch(route, /Your clock-out was not saved/);
  assert.match(page, /PUNCH NOT CONFIRMED/);
  assert.match(page, /role="alert" aria-live="assertive"/);
  assert.match(page, /Retry same punch/);
  assert.match(page, /Do not keep pressing the button\./);
  assert.match(css, /\.clockCriticalAlert/);
  assert.match(css, /border:3px solid var\(--danger\)/);
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
  assert.match(correction, /\$\{`Correction: \$\{reason\}`\}::text/);
  assert.match(correction, /if \(!after\) \{[\s\S]*Shift correction was not saved\. Reload payroll and try again\./);
  assert.match(correction, /INSERT INTO time_entry_adjustments/);
});

test("owner Tiki correction saves the punch first and treats cleanup as best-effort", () => {
  const route = source("src/app/api/tiki-time-corrections/route.ts");

  assert.match(route, /async function correctTikiPunch\(/);
  assert.match(
    route,
    /UPDATE time_entries SET[\s\S]*clock_in = \$\{clockIn\.toISOString\(\)\}[\s\S]*clock_out = \$\{clockOut\?\.toISOString\(\) \|\| null\}[\s\S]*RETURNING \*/,
  );
  assert.ok(
    (route.match(/::text\)/g) || []).length >= 4,
    "Every Tiki correction note passed to CONCAT_WS must be explicitly typed as text.",
  );
  assert.match(route, /if \(!saved\) throw new Error\("The Tiki punch update returned no row\."\)/);
  assert.match(route, /try \{[\s\S]*await adjustment\([\s\S]*primary audit failed/);
  assert.match(route, /try \{[\s\S]*await reconcileLiveClockState\([\s\S]*live-clock cleanup failed/);
  assert.match(route, /requestId = crypto\.randomUUID\(\)\.slice\(0, 8\)/);
  assert.match(route, /Tiki correction failed \[\$\{requestId\}\]/);
  assert.match(route, /return Response\.json\(await correctTikiPunch\(/);
});
