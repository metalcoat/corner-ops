import test from "node:test";
import assert from "node:assert/strict";
import {
  autoSendDecision,
  autoSendSkippedEmail,
  blockerReasons,
  mondayJobWeek,
  payrollMondaySchedule,
  payrollMondaySummaryEmail,
  payrollSummaryFingerprint,
  scheduleOffLines,
  shiftWindowText,
  summaryDecision,
  summaryWasLate,
  SUNDAY_MISSING_WARNING,
} from "../src/lib/payroll-auto-rules.js";
import { submitConfirmed } from "../src/lib/payroll-relief-timesheet.js";

const WEEK = "2026-10-05"; // Monday 2026-10-12 is EDT (UTC-4).
const iso = (d: Date) => d.toISOString();

test("Monday times are Eastern and DST-correct", () => {
  const s = payrollMondaySchedule(WEEK);
  assert.equal(s.monday, "2026-10-12");
  assert.equal(iso(s.weekEnd), "2026-10-12T08:00:00.000Z");
  assert.equal(iso(s.summaryAt), "2026-10-12T12:00:00.000Z");
  assert.equal(iso(s.sundayFallbackAt), "2026-10-12T16:00:00.000Z");
  assert.equal(iso(s.autoSendAt), "2026-10-12T21:00:00.000Z");
  assert.equal(iso(s.windowEnd), "2026-10-14T04:00:00.000Z");
  assert.equal(iso(s.sundayStart), "2026-10-11T08:00:00.000Z");
  // Fall back (Nov 1, 2026): Monday Nov 2 is EST (UTC-5).
  const fall = payrollMondaySchedule("2026-10-26");
  assert.equal(iso(fall.summaryAt), "2026-11-02T13:00:00.000Z");
  assert.equal(iso(fall.autoSendAt), "2026-11-02T22:00:00.000Z");
  // Sunday Nov 1 4 AM is still EST after the 2 AM change.
  assert.equal(iso(fall.sundayStart), "2026-11-01T09:00:00.000Z");
  // Spring forward (2 AM Mar 8, 2026): Sunday 4 AM is already EDT; Monday Mar 9 5 PM is EDT.
  const spring = payrollMondaySchedule("2026-03-02");
  assert.equal(iso(spring.autoSendAt), "2026-03-09T21:00:00.000Z");
  assert.equal(iso(spring.summaryAt), "2026-03-09T12:00:00.000Z");
  assert.equal(iso(spring.sundayStart), "2026-03-08T08:00:00.000Z");
  assert.equal(iso(spring.sundayEnd), "2026-03-09T08:00:00.000Z");
});

test("the week Monday's jobs are about", () => {
  assert.equal(mondayJobWeek(new Date("2026-10-12T21:00:00Z")), WEEK);
  assert.equal(mondayJobWeek(new Date("2026-10-13T20:00:00Z")), WEEK);
  assert.equal(mondayJobWeek(new Date("2026-10-14T03:59:00Z")), WEEK); // Tue 11:59 PM EDT
  assert.equal(mondayJobWeek(new Date("2026-11-02T22:00:00Z")), "2026-10-26");
});

test("8 AM summary: waits for Sunday's punches until noon, then sends with a warning", () => {
  const base = { weekStart: WEEK, sundayScheduledShifts: 4, sundayPunches: 0, alreadySent: false };
  assert.deepEqual(summaryDecision({ ...base, now: new Date("2026-10-12T11:59:00Z") }), { action: "too_early", sundayMissing: true });
  assert.deepEqual(summaryDecision({ ...base, now: new Date("2026-10-12T12:00:00Z") }), { action: "wait_for_sunday", sundayMissing: true });
  assert.deepEqual(summaryDecision({ ...base, now: new Date("2026-10-12T15:45:00Z") }), { action: "wait_for_sunday", sundayMissing: true });
  assert.deepEqual(summaryDecision({ ...base, now: new Date("2026-10-12T16:00:00Z") }), { action: "send", sundayMissing: true });
  // Punches arrived at 9:30: send then, no warning.
  assert.deepEqual(summaryDecision({ ...base, sundayPunches: 7, now: new Date("2026-10-12T13:30:00Z") }), { action: "send", sundayMissing: false });
  // No Sunday shifts: nothing to wait for.
  assert.deepEqual(summaryDecision({ ...base, sundayScheduledShifts: 0, now: new Date("2026-10-12T12:00:00Z") }), { action: "send", sundayMissing: false });
  // Once only; not after approval; not after Tuesday.
  assert.equal(summaryDecision({ ...base, alreadySent: true, now: new Date("2026-10-12T17:00:00Z") }).action, "already_sent");
  assert.equal(summaryDecision({ ...base, approved: true, now: new Date("2026-10-12T17:00:00Z") }).action, "already_approved");
  assert.equal(summaryDecision({ ...base, now: new Date("2026-10-14T04:00:00Z") }).action, "window_closed");
});

test("a summary that only went out at 3 PM or later doesn't lead to an automatic send", () => {
  assert.equal(summaryWasLate(WEEK, new Date("2026-10-12T18:59:00Z")), false);
  assert.equal(summaryWasLate(WEEK, new Date("2026-10-12T19:00:00Z")), true);
  assert.equal(summaryWasLate(WEEK, null), false);
});

const ready = {
  weekStart: WEEK, latestStatus: "Draft" as const, everLocked: false, heldBy: null,
  summarySentAt: new Date("2026-10-12T12:00:00Z"), sundayMissing: false, blockers: [] as string[], decided: false,
};

test("5 PM automatic send: window and DST", () => {
  assert.equal(autoSendDecision({ ...ready, now: new Date("2026-10-12T20:59:00Z") }).action, "too_early");
  assert.equal(autoSendDecision({ ...ready, now: new Date("2026-10-12T21:00:00Z") }).action, "approve");
  assert.equal(autoSendDecision({ ...ready, now: new Date("2026-10-14T03:59:00Z") }).action, "approve");
  assert.equal(autoSendDecision({ ...ready, now: new Date("2026-10-14T04:00:00Z") }).action, "window_closed");
  const fall = { ...ready, weekStart: "2026-10-26", summarySentAt: new Date("2026-11-02T13:00:00Z") };
  assert.equal(autoSendDecision({ ...fall, now: new Date("2026-11-02T21:30:00Z") }).action, "too_early"); // 4:30 PM EST
  assert.equal(autoSendDecision({ ...fall, now: new Date("2026-11-02T22:00:00Z") }).action, "approve");
});

test("5 PM automatic send: idempotent, hold and blockers", () => {
  const now = new Date("2026-10-12T21:05:00Z");
  assert.equal(autoSendDecision({ ...ready, now, decided: true }).action, "already_decided");
  assert.equal(autoSendDecision({ ...ready, now, latestStatus: "Locked" }).action, "already_approved");
  assert.deepEqual(autoSendDecision({ ...ready, now, heldBy: "owner@x.com" }), { action: "not_sent", reasons: ["it's on hold (by owner@x.com)"] });
  assert.deepEqual(autoSendDecision({ ...ready, now, blockers: blockerReasons({ openPunches: 1, unresolvedClockOuts: 2 }) }), {
    action: "not_sent", reasons: ["1 open punch", "2 missed clock-outs to resolve"],
  });
  assert.deepEqual(autoSendDecision({ ...ready, now, summarySentAt: null }).reasons, ["the 8 AM summary email wasn't sent"]);
  assert.deepEqual(autoSendDecision({ ...ready, now, sundayMissing: true }).reasons, ["sunday's hours haven't arrived yet"]);
  assert.deepEqual(autoSendDecision({ ...ready, now, everLocked: true }).reasons, ["it was approved and then reopened"]);
  assert.match(autoSendDecision({ ...ready, now, summarySentAt: new Date("2026-10-12T19:30:00Z") }).reasons[0], /only went out at 3:30 PM/);
  // No draft yet is fine: it's recalculated and drafted at 5 PM.
  assert.equal(autoSendDecision({ ...ready, now, latestStatus: null }).action, "approve");
});

test("a recalculated payroll counts as changed only when hours, tips or schedule lines change", () => {
  const a = { rows: [{ employee: "Sean", hours: 10, regularHours: 10, tips: 20.001 }, { employee: "Ana", hours: 5 }], scheduleComparison: [{ employee: "Sean", text: "x", flagged: false }] };
  const b = { rows: [{ employee: "ana ", hours: 5.0001 }, { employee: "Sean", hours: 10, regularHours: 10, tips: 20 }], scheduleComparison: [{ employee: "Sean", text: "x", flagged: false }], tipDetails: [1, 2] };
  assert.equal(payrollSummaryFingerprint(a), payrollSummaryFingerprint(b));
  assert.notEqual(payrollSummaryFingerprint(a), payrollSummaryFingerprint({ ...a, rows: [{ employee: "Sean", hours: 10.5 }] }));
  assert.notEqual(payrollSummaryFingerprint(a), payrollSummaryFingerprint({ ...a, scheduleComparison: [{ employee: "Sean", text: "x", flagged: true }] }));
});

const rows = [
  { employee: "Lillian", regularHours: 8.25, tippedHours: 0, tips: 40, overtimeHours: 0,
    schedule: { text: "Scheduled 12.00 · worked 8.25 · -3.75 · 1 missed shift", flagged: true, missed: [{ startsAt: "2026-10-11T15:00:00.000Z", endsAt: "2026-10-11T19:00:00.000Z" }] } },
  { employee: "Mike", regularHours: 0, tippedHours: 0, tips: 0, overtimeHours: 0, schedule: { text: "Not tracked (salaried)", flagged: false, untracked: true } },
  { employee: "Sean", regularHours: 30, tippedHours: 5, tips: 80, overtimeHours: 0, schedule: { text: "Scheduled 35.00 · worked 35.00 · 0.00", flagged: false } },
];

test("what's off from the schedule lists flagged people with missed shift times, and salaried people apart", () => {
  assert.equal(shiftWindowText("2026-10-11T15:00:00.000Z", "2026-10-11T19:00:00.000Z"), "Sun 10/11 11:00 AM–3:00 PM");
  assert.deepEqual(scheduleOffLines(rows), [
    "- Lillian: Scheduled 12.00 · worked 8.25 · -3.75 · 1 missed shift",
    "    Missed: Sun 10/11 11:00 AM–3:00 PM",
    "Not tracked (salaried): Mike",
  ]);
  assert.deepEqual(scheduleOffLines([rows[2]]), ["Everyone worked within an hour of their schedule, with no missed shifts."]);
});

const emailBase = {
  business: "Corner Deli" as const, weekStart: WEEK, rows, draft: { version: 3, created: true }, blockers: [] as string[],
  missingSquareFees: 0, needsReview: 0, sundayMissing: false, autoSend: true, late: false,
  reviewLink: "https://team/ops/payroll-control?business=Corner%20Deli&weekStart=2026-10-05",
  holdLink: "https://team/ops/payroll-control?business=Corner%20Deli&weekStart=2026-10-05&hold=1",
};

test("Monday summary email: table, schedule, 5 PM line and links", () => {
  const email = payrollMondaySummaryEmail(emailBase);
  assert.equal(email.subject, "Corner Deli payroll 10/5–10/11: sends to AccountantsOffice at 5 PM");
  assert.match(email.text, /^Corner Deli payroll, week of 10\/5–10\/11\. Draft v3 \(recalculated this morning\)\./);
  assert.match(email.text, /Employee \| Regular Hours \| Tipped Hours \| Tips/);
  assert.match(email.text, /What's off from the schedule:\n- Lillian/);
  assert.match(email.text, /This will be sent to AccountantsOffice automatically at 5:00 PM today unless you put it on Hold or something blocks it\./);
  assert.match(email.text, /Review: https:\/\/team\/ops\/payroll-control\?business=Corner%20Deli&weekStart=2026-10-05\n/);
  assert.match(email.text, /Hold \(opens the payroll page; press Hold there\): .*&hold=1$/);
  assert.doesNotMatch(email.text, /HAVEN'T ARRIVED/);
});

test("Monday summary email: Sunday warning, blockers, late, the Docks", () => {
  const sunday = payrollMondaySummaryEmail({ ...emailBase, sundayMissing: true });
  assert.equal(sunday.subject, `Corner Deli payroll 10/5–10/11: ${SUNDAY_MISSING_WARNING}`);
  assert.match(sunday.text, /^\*\*\* SUNDAY'S HOURS HAVEN'T ARRIVED YET \*\*\*/);
  const blocked = payrollMondaySummaryEmail({ ...emailBase, blockers: ["1 open punch"], clockOutsToCheck: 2 });
  assert.equal(blocked.subject, "Corner Deli payroll 10/5–10/11: needs attention");
  assert.match(blocked.text, /- 1 open punch \(blocks approval\)/);
  assert.match(blocked.text, /- 2 clock-outs to check/);
  assert.match(blocked.text, /Right now something blocks it/);
  const late = payrollMondaySummaryEmail({ ...emailBase, late: true });
  assert.match(late.text, /went out late, so it won't be sent to AccountantsOffice automatically/);
  assert.doesNotMatch(late.text, /Hold \(/);
  const docks = payrollMondaySummaryEmail({ ...emailBase, business: "Tiki", autoSend: false });
  assert.match(docks.text, /The Docks isn't sent to AccountantsOffice automatically/);
  assert.equal(docks.subject, "Tiki payroll 10/5–10/11: ready to approve");
});

test("not-sent-at-5-PM email", () => {
  const email = autoSendSkippedEmail({ business: "Corner Deli", weekStart: WEEK, reasons: ["it's on hold (by chris)", "1 open punch"], link: "https://x" });
  assert.equal(email.subject, "Corner Deli payroll 10/5–10/11 was not sent at 5 PM");
  assert.match(email.text, /^Not sent at 5 PM: it's on hold \(by chris\); 1 open punch — approve on the payroll page when ready\./);
});

test("Submit is confirmed only when the week is no longer the open payroll, or listed as Approved", () => {
  assert.equal(submitConfirmed({ pageText: "", open: { start: "2026-10-05", end: "2026-10-11" }, weekStart: WEEK }), false);
  assert.equal(submitConfirmed({ pageText: "", open: { start: "2026-10-12", end: "2026-10-18" }, weekStart: WEEK }), true);
  assert.equal(submitConfirmed({ pageText: "Payroll History 10/5/2026 - 10/11/2026 Approved", open: null, weekStart: WEEK }), true);
  assert.equal(submitConfirmed({ pageText: "Something went wrong", open: null, weekStart: WEEK }), false);
  assert.equal(submitConfirmed({ pageText: "10/5/2026 Pending", open: null, weekStart: WEEK }), false);
});
