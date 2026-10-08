import test from "node:test";
import assert from "node:assert/strict";
import {
  compareScheduleToWorked,
  discrepancyText,
  payrollDisplayCsvRows,
  payrollDisplayRows,
  showOvertimeColumn,
  signedHours,
} from "../src/lib/payroll-schedule-compare.js";

// Week of Mon 2026-09-28 (EDT, UTC-4).
const at = (local: string) => new Date(`${local}-04:00`).toISOString();
const NOW = new Date("2026-10-05T12:00:00Z");

test("scheduled vs worked: difference, flags and missed shifts", () => {
  const result = compareScheduleToWorked({
    now: NOW,
    rows: [
      { employee: "Sean", hours: 16.5 },
      { employee: "Lillian", hours: 8.25 },
      { employee: "Walk In", hours: 3 },
    ],
    shifts: [
      // Sean: two 8-hour shifts, worked both (one punch starts 30 minutes early).
      { employeeId: "e1", employeeName: "Sean", startsAt: at("2026-09-28T10:00:00"), endsAt: at("2026-09-28T18:00:00") },
      { employeeId: "e1", employeeName: "Sean", startsAt: at("2026-09-29T10:00:00"), endsAt: at("2026-09-29T18:00:00") },
      // Lillian: two shifts, only one worked.
      { employeeId: "e2", employeeName: "Lillian", startsAt: at("2026-09-30T11:00:00"), endsAt: at("2026-09-30T19:00:00") },
      { employeeId: "e2", employeeName: "Lillian", startsAt: at("2026-10-01T11:00:00"), endsAt: at("2026-10-01T15:00:00") },
      // Seth: scheduled, never came in.
      { employeeId: "e3", employeeName: "Seth", startsAt: at("2026-10-02T16:00:00"), endsAt: at("2026-10-02T22:00:00") },
    ],
    punches: [
      { employeeName: "sean", clockIn: at("2026-09-28T09:30:00"), clockOut: at("2026-09-28T18:00:00") },
      { employeeName: "Sean ", clockIn: at("2026-09-29T10:00:00"), clockOut: at("2026-09-29T18:00:00") },
      { employeeName: "Lillian", clockIn: at("2026-09-30T11:00:00"), clockOut: at("2026-09-30T19:15:00") },
      { employeeName: "Walk In", clockIn: at("2026-10-03T10:00:00"), clockOut: at("2026-10-03T13:00:00") },
    ],
  });
  const by = Object.fromEntries(result.map((r) => [r.employee, r]));
  assert.deepEqual(Object.keys(by), ["Lillian", "Sean", "Seth", "Walk In"]);
  assert.equal(by.Sean.scheduledHours, 16);
  assert.equal(by.Sean.difference, 0.5);
  assert.equal(by.Sean.missedShifts, 0);
  assert.equal(by.Sean.flagged, false);
  assert.equal(by.Sean.text, "Scheduled 16.00 · worked 16.50 · +0.50");
  assert.equal(by.Lillian.scheduledHours, 12);
  assert.equal(by.Lillian.difference, -3.75);
  assert.equal(by.Lillian.missedShifts, 1);
  assert.equal(by.Lillian.flagged, true);
  assert.equal(by.Lillian.text, "Scheduled 12.00 · worked 8.25 · -3.75 · 1 missed shift");
  // Scheduled but no hours at all: still listed, worked 0.
  assert.deepEqual({ ...by.Seth, text: undefined }, { employee: "Seth", scheduledHours: 6, workedHours: 0, difference: -6, scheduledShifts: 1, missedShifts: 1, flagged: true, text: undefined });
  assert.equal(by["Walk In"].text, "Not scheduled · worked 3.00");
  assert.equal(by["Walk In"].flagged, true);
});

test("employee ids win over names when both sides have one; future shifts aren't missed", () => {
  const result = compareScheduleToWorked({
    now: new Date(at("2026-10-01T12:00:00")),
    rows: [{ employee: "Ana", hours: 5 }],
    shifts: [
      { employeeId: "a1", employeeName: "Ana", startsAt: at("2026-09-30T10:00:00"), endsAt: at("2026-09-30T15:00:00") },
      { employeeId: "a1", employeeName: "Ana", startsAt: at("2026-10-02T10:00:00"), endsAt: at("2026-10-02T15:00:00") },
    ],
    // Same name, different person (id b2): doesn't count for Ana's shift. Ana's own punch has her id under another spelling.
    punches: [
      { employeeId: "b2", employeeName: "Ana", clockIn: at("2026-09-30T10:00:00"), clockOut: at("2026-09-30T15:00:00") },
    ],
  });
  assert.equal(result[0].missedShifts, 1);
  const own = compareScheduleToWorked({
    now: new Date(at("2026-10-01T12:00:00")),
    rows: [{ employee: "Ana", hours: 5 }],
    shifts: [{ employeeId: "a1", employeeName: "Ana", startsAt: at("2026-09-30T10:00:00"), endsAt: at("2026-09-30T15:00:00") }],
    punches: [{ employeeId: "a1", employeeName: "Ana Diaz", clockIn: at("2026-09-30T10:05:00"), clockOut: null }],
  });
  assert.equal(own[0].missedShifts, 0);
  assert.equal(own[0].flagged, false);
});

test("a punch just outside the shift (within an hour) still counts; further away doesn't", () => {
  const shift = { employeeName: "Kim", startsAt: at("2026-09-30T10:00:00"), endsAt: at("2026-09-30T14:00:00") };
  const near = compareScheduleToWorked({ now: NOW, rows: [], shifts: [shift], punches: [{ employeeName: "Kim", clockIn: at("2026-09-30T14:45:00"), clockOut: at("2026-09-30T18:00:00") }] });
  assert.equal(near[0].missedShifts, 0);
  const far = compareScheduleToWorked({ now: NOW, rows: [], shifts: [shift], punches: [{ employeeName: "Kim", clockIn: at("2026-09-30T16:00:00"), clockOut: at("2026-09-30T20:00:00") }] });
  assert.equal(far[0].missedShifts, 1);
});

test("display rows: payroll columns plus scheduled-only employees; OT only when someone has it", () => {
  const rows = [
    { employee: "Sean", hours: 16.5, regularHours: 12, driverTipHours: 4.5, overtimeHours: 0, tips: 80.456 },
  ];
  const comparison = compareScheduleToWorked({
    now: NOW, rows,
    shifts: [{ employeeName: "Seth", startsAt: at("2026-10-02T16:00:00"), endsAt: at("2026-10-02T22:00:00") }],
    punches: [],
  });
  const display = payrollDisplayRows(rows, comparison);
  assert.deepEqual(display.map((r) => [r.employee, r.regularHours, r.tippedHours, r.tips]), [["Sean", 12, 4.5, 80.46], ["Seth", 0, 0, 0]]);
  assert.equal(display[1].schedule?.missedShifts, 1);
  assert.equal(showOvertimeColumn(display), false);
  const csv = payrollDisplayCsvRows(display);
  assert.deepEqual(csv[0], ["Employee", "Regular Hours", "Tipped Hours", "Tips", "Scheduled Hours", "Worked Hours", "Difference (worked - scheduled)", "Missed Shifts", "Scheduled vs Worked", "Flag"]);
  assert.deepEqual(csv[2], ["Seth", "0.00", "0.00", "0.00", "6.00", "0.00", "-6.00", "1", "Scheduled 6.00; worked 0.00; -6.00; 1 missed shift", "Check"]);
  const withOt = payrollDisplayCsvRows(payrollDisplayRows([{ ...rows[0], overtimeHours: 2 }], comparison));
  assert.equal(withOt[0][4], "Overtime Hours");
  assert.equal(withOt[1][4], "2.00");
});

test("signed differences and text", () => {
  assert.equal(signedHours(1.234), "+1.23");
  assert.equal(signedHours(-0.004), "0.00");
  assert.equal(discrepancyText({ scheduledHours: 8, workedHours: 0, difference: -8, scheduledShifts: 2, missedShifts: 2 }), "Scheduled 8.00 · worked 0.00 · -8.00 · 2 missed shifts");
});
