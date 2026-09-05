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

test("Tiki clock-out failure is explicit and visually unmistakable", () => {
  const tiki = source("src/lib/tiki-timeclock.ts");
  const route = source("src/app/api/timeclock/route.ts");
  const page = source("src/app/clock/page.tsx");
  const css = source("src/app/clock/clock.css");

  assert.match(tiki, /class TikiClockOutSaveError extends Error/);
  assert.match(tiki, /readonly code = "CLOCK_OUT_FAILED"/);
  assert.match(tiki, /clock-out update failed/);
  assert.match(tiki, /if \(!entry\) throw new TikiClockOutSaveError\(\)/);
  assert.match(route, /error instanceof TikiClockOutSaveError/);
  assert.match(route, /code: error\.code/);
  assert.match(route, /Your clock-out was not saved\. You are still clocked in\./);
  assert.match(page, /title: "CLOCK OUT FAILED"/);
  assert.match(page, /title: "PUNCH NOT CONFIRMED"/);
  assert.match(page, /role="alert" aria-live="assertive"/);
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
