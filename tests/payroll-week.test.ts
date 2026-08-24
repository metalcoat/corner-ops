import test from "node:test";
import assert from "node:assert/strict";
import { currentPayrollWeekStart, payrollWeekBounds } from "../src/lib/payroll-week.js";

test("payroll week begins Monday at 4 AM Eastern", () => {
  const bounds = payrollWeekBounds("2026-08-24");
  assert.equal(bounds.start.toISOString(), "2026-08-24T08:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-31T08:00:00.000Z");
});

test("spring-forward payroll week is 167 elapsed hours", () => {
  const bounds = payrollWeekBounds("2026-03-02");
  assert.equal(bounds.start.toISOString(), "2026-03-02T09:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-03-09T08:00:00.000Z");
  assert.equal((bounds.end.getTime() - bounds.start.getTime()) / 3_600_000, 167);
});

test("fall-back payroll week is 169 elapsed hours", () => {
  const bounds = payrollWeekBounds("2026-10-26");
  assert.equal(bounds.start.toISOString(), "2026-10-26T08:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-11-02T09:00:00.000Z");
  assert.equal((bounds.end.getTime() - bounds.start.getTime()) / 3_600_000, 169);
});

test("Monday before 4 AM still belongs to the prior payroll week", () => {
  assert.equal(currentPayrollWeekStart(new Date("2026-08-24T06:00:00.000Z")), "2026-08-17");
  assert.equal(currentPayrollWeekStart(new Date("2026-08-24T09:00:00.000Z")), "2026-08-24");
});
