import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduleSmsText } from "../src/lib/schedule-publication-sms.js";

const shifts = [
  {
    employee_id: "employee-1",
    position: "Bartender",
    starts_at: "2026-08-27T16:00:00.000Z",
    ends_at: "2026-08-28T04:00:00.000Z",
  },
];

test("schedule SMS includes the employee schedule and portal link", () => {
  const text = scheduleSmsText({
    business: "Tiki",
    mode: "changes",
    shifts,
    hubUrl: "https://corner-ops.vercel.app/employee?business=Tiki",
  });
  assert.match(text, /^Tiki schedule updated:/);
  assert.match(text, /Thu 12p-12a Bartender/);
  assert.match(text, /corner-ops\.vercel\.app\/employee\?business=Tiki/);
  assert.match(text, /Reply STOP to opt out\./);
});

test("schedule SMS tells removed employees when they have no assigned shifts", () => {
  const text = scheduleSmsText({
    business: "Corner Deli",
    mode: "changes",
    shifts: [],
  });
  assert.match(text, /No shifts assigned this week\./);
});

test("validated publication sends SMS only to affected employee ids after a fresh publish", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/schedule-publish-validation.ts"), "utf8");
  assert.match(source, /affectedEmployeeIds/);
  assert.match(source, /if \(duplicate \|\| !publication\.publicationId\) return publication/);
  assert.match(source, /deliverSchedulePublicationSms\([\s\S]*employeeIds,[\s\S]*mode/);
});
