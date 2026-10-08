import test from "node:test";
import assert from "node:assert/strict";
import {
  businessDayCloseUtc,
  clockOutTimeProblem,
  employeeLeftAtOwnerEmail,
  localDateKey,
  missedClockOutDecision,
  missedClockOutOwnerEmail,
  missedClockOutSmsPlan,
  missedClockOutSmsText,
  parseEasternInput,
  payrollApprovalBlockMessage,
  payrollApprovalEmail,
  payrollCodeEmail,
  payrollSubmissionEmail,
  payrollWeekLabel,
  resolveMissedClockOutClose,
  submissionStatusLine,
  wallTimeToUtc,
} from "../src/lib/missed-clock-out-rules.js";

const iso = (value: Date | null) => value?.toISOString() ?? null;

test("business day close on a summer evening (EDT)", () => {
  assert.equal(iso(businessDayCloseUtc("2026-10-09", [{ opens: "10:30:00", closes: "22:30:00" }])), "2026-10-10T02:30:00.000Z");
});

test("a close after midnight lands on the next calendar day", () => {
  assert.equal(iso(businessDayCloseUtc("2026-10-09", [{ opens: "18:00:00", closes: "02:00:00" }])), "2026-10-10T06:00:00.000Z");
  // Midnight exactly is also the next day.
  assert.equal(iso(businessDayCloseUtc("2026-10-09", [{ opens: "16:00", closes: "00:00" }])), "2026-10-10T04:00:00.000Z");
});

test("the latest of several openings is the close; no openings means no close", () => {
  assert.equal(iso(businessDayCloseUtc("2026-10-09", [
    { opens: "11:00", closes: "14:00" },
    { opens: "17:00", closes: "21:00" },
  ])), "2026-10-10T01:00:00.000Z");
  assert.equal(businessDayCloseUtc("2026-10-09", []), null);
  assert.equal(businessDayCloseUtc("2026-10-09", [{ opens: "bad", closes: "21:00" }]), null);
});

test("closes across the fall-back change use the right offset", () => {
  // Night of Oct 31 2026 runs to 1:30 AM on Nov 1, the fall-back date: first (EDT) 1:30.
  assert.equal(iso(businessDayCloseUtc("2026-10-31", [{ opens: "18:00", closes: "01:30" }])), "2026-11-01T05:30:00.000Z");
  // Later on Nov 1 it is EST.
  assert.equal(iso(businessDayCloseUtc("2026-11-01", [{ opens: "10:30", closes: "21:30" }])), "2026-11-02T02:30:00.000Z");
});

test("closes across the spring-forward change use the right offset", () => {
  assert.equal(iso(businessDayCloseUtc("2026-03-07", [{ opens: "10:30", closes: "21:30" }])), "2026-03-08T02:30:00.000Z");
  assert.equal(iso(businessDayCloseUtc("2026-03-08", [{ opens: "10:30", closes: "21:30" }])), "2026-03-09T01:30:00.000Z");
  // A 3 AM close on the spring-forward night is 3 AM EDT.
  assert.equal(iso(businessDayCloseUtc("2026-03-07", [{ opens: "18:00", closes: "03:00" }])), "2026-03-08T07:00:00.000Z");
});

test("wall time conversion and local dates", () => {
  assert.equal(wallTimeToUtc("2026-07-04", 9 * 60).toISOString(), "2026-07-04T13:00:00.000Z");
  assert.equal(wallTimeToUtc("2026-12-04", 9 * 60).toISOString(), "2026-12-04T14:00:00.000Z");
  assert.equal(localDateKey(new Date("2026-10-10T03:30:00Z")), "2026-10-09");
});

test("a punch belongs to the business day whose close is next", () => {
  const closes = [
    { businessDate: "2026-10-09", closeAt: businessDayCloseUtc("2026-10-09", [{ opens: "18:00", closes: "02:00" }]) },
    { businessDate: "2026-10-10", closeAt: businessDayCloseUtc("2026-10-10", [{ opens: "18:00", closes: "02:00" }]) },
  ];
  // 12:30 AM Saturday is still Friday night.
  const lateNight = resolveMissedClockOutClose({ clockIn: new Date("2026-10-10T04:30:00Z"), closes, scheduledEnd: null });
  assert.equal(lateNight.basis, "business_close");
  assert.equal(lateNight.businessDate, "2026-10-09");
  assert.equal(lateNight.closeAt.toISOString(), "2026-10-10T06:00:00.000Z");
  assert.equal(lateNight.dueAt.toISOString(), "2026-10-10T07:00:00.000Z");
  // 5 PM Saturday belongs to Saturday night.
  const evening = resolveMissedClockOutClose({ clockIn: new Date("2026-10-10T21:00:00Z"), closes, scheduledEnd: null });
  assert.equal(evening.businessDate, "2026-10-10");
  assert.equal(evening.closeAt.toISOString(), "2026-10-11T06:00:00.000Z");
});

test("without business hours the scheduled shift end is used, then the longest shift", () => {
  const clockIn = new Date("2026-10-09T14:02:00Z");
  const scheduled = resolveMissedClockOutClose({
    clockIn,
    closes: [{ businessDate: "2026-10-08", closeAt: null }, { businessDate: "2026-10-09", closeAt: null }],
    scheduledEnd: new Date("2026-10-09T22:00:00Z"),
  });
  assert.equal(scheduled.basis, "scheduled_end");
  assert.equal(scheduled.businessDate, "2026-10-09");
  assert.equal(scheduled.dueAt.toISOString(), "2026-10-09T23:00:00.000Z");

  const fallback = resolveMissedClockOutClose({ clockIn, closes: [], scheduledEnd: null });
  assert.equal(fallback.basis, "max_shift");
  assert.equal(fallback.closeAt.toISOString(), "2026-10-10T06:02:00.000Z");

  // Clocked in after close: the shift end applies.
  const afterClose = resolveMissedClockOutClose({
    clockIn: new Date("2026-10-10T02:00:00Z"),
    closes: [{ businessDate: "2026-10-09", closeAt: new Date("2026-10-10T01:30:00Z") }],
    scheduledEnd: new Date("2026-10-10T04:00:00Z"),
  });
  assert.equal(afterClose.basis, "scheduled_end");
});

test("each open punch is handled once", () => {
  const dueAt = new Date("2026-10-10T07:00:00Z");
  assert.equal(missedClockOutDecision({ now: new Date(dueAt.getTime() - 1), dueAt, hasCase: false, clockedOut: false }), "not_due");
  assert.equal(missedClockOutDecision({ now: dueAt, dueAt, hasCase: false, clockedOut: false }), "create");
  assert.equal(missedClockOutDecision({ now: new Date("2026-10-11T00:00:00Z"), dueAt, hasCase: true, clockedOut: false }), "already_handled");
  assert.equal(missedClockOutDecision({ now: new Date("2026-10-11T00:00:00Z"), dueAt, hasCase: false, clockedOut: true }), "closed");
});

test("texts go only to consenting employees with a phone, near the close", () => {
  const dueAt = new Date("2026-10-10T07:00:00Z");
  const now = new Date("2026-10-10T07:10:00Z");
  assert.deepEqual(missedClockOutSmsPlan({ now, dueAt, smsOptIn: true, phone: "315-555-0100", active: true }), { send: true });
  assert.deepEqual(missedClockOutSmsPlan({ now, dueAt, smsOptIn: false, phone: "315-555-0100", active: true }), { send: false, reason: "not_opted_in" });
  assert.deepEqual(missedClockOutSmsPlan({ now, dueAt, smsOptIn: true, phone: " ", active: true }), { send: false, reason: "no_phone" });
  assert.deepEqual(missedClockOutSmsPlan({ now: new Date("2026-10-12T07:00:00Z"), dueAt, smsOptIn: true, phone: "3155550100", active: true }), { send: false, reason: "too_late" });
  assert.deepEqual(missedClockOutSmsPlan({ now, dueAt, smsOptIn: true, phone: "3155550100", active: false }), { send: false, reason: "inactive" });
});

test("typed times are Eastern wall time", () => {
  assert.equal(iso(parseEasternInput("2026-10-08T21:45")), "2026-10-09T01:45:00.000Z");
  assert.equal(iso(parseEasternInput("2026-12-08T21:45")), "2026-12-09T02:45:00.000Z");
  assert.equal(iso(parseEasternInput("2026-10-08 9:45 PM")), "2026-10-09T01:45:00.000Z");
  assert.equal(iso(parseEasternInput("2026-10-09T01:45:00.000Z")), "2026-10-09T01:45:00.000Z");
  assert.equal(parseEasternInput("yesterday"), null);
  assert.equal(parseEasternInput(""), null);
});

test("a reported clock-out must be after clock-in, not in the future, and not too long", () => {
  const clockIn = new Date("2026-10-09T14:00:00Z");
  const now = new Date("2026-10-10T03:00:00Z");
  assert.equal(clockOutTimeProblem({ clockIn, clockOut: new Date("2026-10-10T01:45:00Z"), now }), null);
  assert.match(clockOutTimeProblem({ clockIn, clockOut: new Date("2026-10-09T13:00:00Z"), now }) || "", /after you clocked in/);
  assert.match(clockOutTimeProblem({ clockIn, clockOut: clockIn, now }) || "", /after you clocked in/);
  assert.match(clockOutTimeProblem({ clockIn, clockOut: new Date("2026-10-10T03:30:00Z"), now }) || "", /future/);
  // A minute of phone clock drift is fine.
  assert.equal(clockOutTimeProblem({ clockIn, clockOut: new Date("2026-10-10T03:01:00Z"), now }), null);
  const later = new Date("2026-10-11T00:00:00Z");
  assert.match(clockOutTimeProblem({ clockIn, clockOut: new Date("2026-10-10T06:30:00Z"), now: later }) || "", /longer than 16 hours/);
  assert.equal(clockOutTimeProblem({ clockIn, clockOut: new Date("2026-10-10T06:30:00Z"), now: later, maxHours: 24 }), null);
  assert.match(clockOutTimeProblem({ clockIn, clockOut: null, now }) || "", /Enter/);
});

test("employee text is short and links to the time entry page", () => {
  const link = "https://team.ordercornerdeli.com/employee/attendance?business=Corner%20Deli&clockout=abc";
  const text = missedClockOutSmsText({
    employeeName: "Sam Rivera", business: "Corner Deli",
    clockIn: new Date("2026-10-09T14:02:00Z"), now: new Date("2026-10-10T02:40:00Z"), link,
  });
  assert.equal(text, `Hi Sam — you're still clocked in at Corner Deli since 10:02 AM. If you forgot to clock out, tap to enter when you left: ${link} Reply STOP to opt out.`);
  assert.ok(text.length < 300);
  const nextDay = missedClockOutSmsText({
    employeeName: "Sam", business: "Tiki",
    clockIn: new Date("2026-10-09T21:00:00Z"), now: new Date("2026-10-10T07:00:00Z"), link,
  });
  assert.match(nextDay, /since Fri 5:00 PM\./);
});

test("owner emails list each punch and link to the approval page", () => {
  const email = missedClockOutOwnerEmail({
    business: "Corner Deli",
    cases: [
      { employeeName: "Sam Rivera", clockIn: new Date("2026-10-09T14:02:00Z"), scheduledEnd: new Date("2026-10-10T01:00:00Z"), smsNote: "Texted", link: "https://x/ops/payroll-control/clock-outs?case=1" },
      { employeeName: "Ana Diaz", clockIn: new Date("2026-10-09T15:00:00Z"), scheduledEnd: null, smsNote: "Not texted (no SMS consent)", link: "https://x/ops/payroll-control/clock-outs?case=2" },
    ],
  });
  assert.equal(email.subject, "Corner Deli: 2 employees are still clocked in");
  assert.match(email.text, /Sam Rivera\n {2}Clocked in: Fri, Oct 9, 10:02 AM\n {2}Scheduled end: Fri, Oct 9, 9:00 PM/);
  assert.match(email.text, /Scheduled end: No published shift/);
  assert.match(email.text, /clock-outs\?case=2/);
  assert.match(email.text, /Opening a link changes nothing/);
  assert.equal(missedClockOutOwnerEmail({ business: "Tiki", cases: [{ employeeName: "A", clockIn: new Date(), scheduledEnd: null, smsNote: "", link: "" }] }).subject, "Tiki: 1 employee is still clocked in");

  const left = employeeLeftAtOwnerEmail({
    business: "Corner Deli", employeeName: "Sam", leftAt: new Date("2026-10-10T01:45:00Z"), clockIn: new Date("2026-10-09T14:02:00Z"),
    note: "Forgot after closing", link: "https://x/ops/payroll-control/clock-outs?case=1",
  });
  assert.equal(left.subject, "Sam says they left at 9:45 PM");
  assert.match(left.text, /Their note: Forgot after closing/);
  assert.match(left.text, /Approve or change it: https:\/\/x\/ops\/payroll-control\/clock-outs\?case=1/);
});

test("payroll approval is blocked by open punches and missed clock-outs", () => {
  assert.equal(payrollApprovalBlockMessage({ openPunches: 0, unresolvedClockOuts: 0 }), null);
  assert.equal(
    payrollApprovalBlockMessage({ openPunches: 1, unresolvedClockOuts: 2 }),
    "Payroll can't be approved yet: this week still has 1 open punch and 2 missed clock-outs to resolve. Close or correct them first.",
  );
});

test("Monday payroll email summarizes hours, tips and blockers", () => {
  const email = payrollApprovalEmail({
    business: "Tiki",
    weekStart: "2026-09-28",
    rows: [
      { employee: "Ana Diaz", regularHours: 40, tippedHours: 0, overtimeHours: 2.5, tips: 312.4, schedule: { text: "Scheduled 40.00 · worked 42.50 · +2.50", flagged: true } },
      { employee: "Sam Rivera", regularHours: 0, tippedHours: 20, overtimeHours: 0, tips: 100, schedule: { text: "Scheduled 20.00 · worked 20.00 · 0.00", flagged: false } },
    ],
    draft: { version: 1, created: true },
    blockers: { openPunches: 0, unresolvedClockOuts: 1 },
    missingSquareFees: 3,
    needsReview: 2,
    reviewLink: "https://team.atthedocks.com/ops/payroll-control?business=Tiki&weekStart=2026-09-28",
  });
  assert.equal(email.subject, "Tiki payroll for 2026-09-28 – 2026-10-04: needs attention");
  assert.match(email.text, /Employee\s+\| Regular Hours \| Tipped Hours \| Tips\s+\| OT\s+\| Scheduled vs worked/);
  assert.match(email.text, /Ana Diaz\s+\| 40\.00\s+\| 0\.00\s+\| \$312\.40 \| 2\.50 \| CHECK: Scheduled 40\.00 · worked 42\.50 · \+2\.50/);
  assert.match(email.text, /Totals\s+\| 40\.00\s+\| 20\.00\s+\| \$412\.40 \| 2\.50/);
  assert.match(email.text, /1 missed clock-out not resolved \(blocks approval\)/);
  assert.match(email.text, /3 Square payments missing processing fees/);
  assert.match(email.text, /2 punches marked Needs Review/);
  assert.match(email.text, /1 employee worked an hour or more off their schedule/);
  assert.match(email.text, /Draft v1 was created\./);
  assert.match(email.text, /The Docks isn't sent to AccountantsOffice automatically/);
  assert.match(email.text, /Review and approve: https:\/\/team\.atthedocks\.com\/ops\/payroll-control\?business=Tiki&weekStart=2026-09-28/);

  const noOvertime = payrollApprovalEmail({
    business: "Corner Deli", weekStart: "2026-09-28",
    rows: [{ employee: "Sean", regularHours: 30, tippedHours: 5, overtimeHours: 0, tips: 80, schedule: null }],
    draft: { version: 2, created: false }, blockers: { openPunches: 0, unresolvedClockOuts: 0 }, missingSquareFees: 0, needsReview: 0, reviewLink: "x",
  });
  assert.doesNotMatch(noOvertime.text, /\| OT/);
  assert.match(noOvertime.text, /saved, not submitted\) in Payroll Relief/);

  const ready = payrollApprovalEmail({
    business: "Corner Deli", weekStart: "2026-09-28", rows: [], draft: { error: "Square fees missing." },
    blockers: { openPunches: 0, unresolvedClockOuts: 0 }, missingSquareFees: 0, needsReview: 0, reviewLink: "x",
  });
  assert.match(ready.subject, /ready to approve$/);
  assert.match(ready.text, /No hours recorded\./);
  assert.match(ready.text, /could not be created: Square fees missing\./);
});

test("submission status lines and Payroll Relief emails", () => {
  assert.equal(submissionStatusLine("queued"), "Waiting to enter in Payroll Relief");
  assert.equal(submissionStatusLine("submitting"), "Entering hours in Payroll Relief…");
  assert.match(submissionStatusLine("needs_code"), /texted a sign-in code/);
  assert.equal(submissionStatusLine("submitted"), "Saved in Payroll Relief (not submitted): review it there and press Submit");
  assert.match(submissionStatusLine("submitted", "Reg 100.00"), /press Submit\. Reg 100\.00$/);
  assert.equal(submissionStatusLine("failed", "Login rejected"), "Failed: Login rejected");
  assert.equal(submissionStatusLine("submitted", "Found 12 employees", "roster"), "Found 12 employees");
  assert.equal(submissionStatusLine(null), "");
  assert.equal(payrollWeekLabel("2026-09-28"), "9/28–10/4");
  const ok = payrollSubmissionEmail({
    business: "Corner Deli", weekStart: "2026-09-28", version: 2, status: "submitted", message: "",
    link: "https://x", totalsText: "Reg 120.50, Tipped 30.00, Tips $412.40, OT 2.00",
  });
  assert.match(ok.subject, /saved in Payroll Relief/);
  assert.match(ok.text, /^Corner Deli hours for 9\/28–10\/4 are saved in Payroll Relief \(Reg 120\.50, Tipped 30\.00, Tips \$412\.40, OT 2\.00\)\. Review, make any changes, and press Submit there: https:\/\/www\.accountantsoffice\.com\/aocommon\//);
  const failed = payrollSubmissionEmail({ business: "Corner Deli", weekStart: "2026-09-28", version: 2, status: "failed", message: "Payroll Relief's open payroll is 10/5–10/11, not 9/28–10/4.", link: "https://x" });
  assert.match(failed.subject, /could not be entered/);
  assert.match(failed.text, /Reason: Payroll Relief's open payroll is 10\/5–10\/11, not 9\/28–10\/4\./);
  assert.match(failed.text, /Nothing was submitted\./);
  const code = payrollCodeEmail({ business: "Corner Deli", weekStart: "2026-09-28", link: "https://x/pay" });
  assert.match(code.text, /within 10 minutes: https:\/\/x\/pay/);
});
