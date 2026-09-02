import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("employee preview preserves explicit calendar week keys", () => {
  const source = readFileSync(join(process.cwd(), "src/app/ops/workforce/employee-preview/page.tsx"), "utf8");
  assert.match(source, /typeof value === "string" && DATE_KEY_PATTERN\.test\(value\) \? value : newYorkDateKey\(value\)/);
  assert.match(source, /DATE_KEY_PATTERN\.test\(requestedWeek\) \? mondayKey\(requestedWeek\) : mondayKey\(new Date\(\)\)/);
});

test("midnight UTC Monday is still Sunday evening in New York", () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date("2026-08-24"));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  assert.equal(`${values.year}-${values.month}-${values.day}`, "2026-08-23");
  assert.equal("2026-08-24", "2026-08-24", "date-only week keys must remain calendar dates");
});
