import test from "node:test";
import assert from "node:assert/strict";
import {
  autoClosedSmsText,
  autoClosePlan,
  caseBlocksApproval,
  lastScheduledEnd,
  lateClockOutSmsText,
  matchEmployeeByName,
  missedClockOutOwnerEmail,
  missedClockOutSmsPlan,
  rezkuPunchCheck,
  LATE_CLOCK_OUT_MINUTES,
  REZKU_SMS_MAX_AGE_HOURS,
} from "../src/lib/missed-clock-out-rules.js";

// Mon 2026-10-05, EDT (UTC-4).
const at = (local: string) => new Date(`2026-10-05T${local}:00-04:00`);
const shift = (start: string, end: string) => ({ startsAt: at(start), endsAt: at(end) });
const iso = (d: Date | null) => d?.toISOString() ?? null;

test("thresholds", () => {
  assert.equal(LATE_CLOCK_OUT_MINUTES, 60);
  assert.equal(REZKU_SMS_MAX_AGE_HOURS, 48);
});

test("a split double shift is compared against the day's LAST scheduled end", () => {
  const shifts = [shift("10:30", "15:00"), shift("15:30", "18:30")];
  assert.equal(iso(lastScheduledEnd({ clockIn: at("10:27"), clockOut: at("20:02"), shifts })), iso(at("18:30")));
  const check = rezkuPunchCheck({ clockIn: at("10:27"), clockOut: at("20:02"), shifts });
  assert.deepEqual(check, { kind: "late", scheduledEnd: at("18:30"), minutesLate: 92 });
  // Two punches for the split shift: neither is late.
  assert.deepEqual(rezkuPunchCheck({ clockIn: at("10:27"), clockOut: at("15:04"), shifts }), { kind: "ok" });
  assert.deepEqual(rezkuPunchCheck({ clockIn: at("15:28"), clockOut: at("18:40"), shifts }), { kind: "ok" });
});

test("one punch covering two shifts gives one result, not one per shift", () => {
  const shifts = [shift("10:00", "14:00"), shift("14:00", "18:00")];
  const result = rezkuPunchCheck({ clockIn: at("09:58"), clockOut: at("19:30"), shifts });
  assert.equal(result.kind, "late");
  assert.equal(result.kind === "late" && result.minutesLate, 90);
});

test("late threshold is 60 minutes past the scheduled end", () => {
  const shifts = [shift("11:00", "18:30")];
  assert.deepEqual(rezkuPunchCheck({ clockIn: at("11:00"), clockOut: at("19:29"), shifts }), { kind: "ok" });
  assert.equal(rezkuPunchCheck({ clockIn: at("11:00"), clockOut: at("19:30"), shifts }).kind, "late");
});

test("no scheduled shift: unscheduled when longer than an hour; open punches are open", () => {
  assert.deepEqual(rezkuPunchCheck({ clockIn: at("11:00"), clockOut: at("11:50"), shifts: [] }), { kind: "ok" });
  assert.deepEqual(rezkuPunchCheck({ clockIn: at("11:00"), clockOut: at("13:30"), shifts: [] }), { kind: "unscheduled", hours: 2.5 });
  // A shift on another day doesn't count.
  assert.equal(rezkuPunchCheck({ clockIn: at("11:00"), clockOut: at("13:30"), shifts: [{ startsAt: new Date("2026-10-06T15:00:00Z"), endsAt: new Date("2026-10-06T22:00:00Z") }] }).kind, "unscheduled");
  assert.deepEqual(rezkuPunchCheck({ clockIn: at("11:00"), clockOut: null, shifts: [shift("11:00", "18:00")] }), { kind: "open" });
  // A morning shift that ended before an evening punch doesn't make it late.
  assert.equal(rezkuPunchCheck({ clockIn: at("17:00"), clockOut: at("21:00"), shifts: [shift("08:00", "12:00")] }).kind, "unscheduled");
});

test("open time clock punches: matched shift by start window", () => {
  assert.equal(iso(lastScheduledEnd({ clockIn: at("10:27"), clockOut: null, shifts: [shift("10:30", "15:00"), shift("15:30", "18:30")] })), iso(at("18:30")));
  // Shift starting more than 3 hours after the clock-in isn't this punch's.
  assert.equal(lastScheduledEnd({ clockIn: at("06:00"), clockOut: null, shifts: [shift("09:30", "15:00")] }), null);
});

test("automatic close: scheduled end, else business close, else nothing", () => {
  const clockIn = at("10:00");
  const dueAt = at("22:30");
  const byShift = autoClosePlan({ clockIn, scheduledEnd: at("18:30"), businessCloseAt: at("21:30"), dueAt });
  assert.deepEqual(byShift, { closeAt: at("18:30"), basis: "scheduled_end", dueAt });
  const byClose = autoClosePlan({ clockIn, scheduledEnd: null, businessCloseAt: at("21:30"), dueAt });
  assert.deepEqual(byClose, { closeAt: at("21:30"), basis: "business_close", dueAt });
  assert.equal(autoClosePlan({ clockIn, scheduledEnd: null, businessCloseAt: null, dueAt }), null);
  // A scheduled end after the close: wait until an hour after the scheduled end (never close in the future).
  const lateShift = autoClosePlan({ clockIn, scheduledEnd: at("23:00"), businessCloseAt: at("21:30"), dueAt });
  assert.equal(iso(lateShift!.dueAt), iso(new Date(at("23:00").getTime() + 3_600_000)));
});

test("texts: auto-closed and late Rezku clock-out", () => {
  assert.equal(
    autoClosedSmsText({ employeeName: "Sam Lee", business: "Corner Deli", clockIn: at("10:00"), closedAt: at("18:30"), basis: "scheduled_end", link: "https://x/l" }),
    "Hi Sam — you didn't clock out at Corner Deli on Mon 10/5. We closed your shift at your scheduled end, 6:30 PM. If you left at a different time, tap to correct: https://x/l Reply STOP to opt out.",
  );
  assert.match(autoClosedSmsText({ employeeName: "Sam", business: "Corner Deli", clockIn: at("10:00"), closedAt: at("21:30"), basis: "business_close", link: "l" }), /at closing time, 9:30 PM/);
  assert.equal(
    lateClockOutSmsText({ employeeName: "Devin", clockOut: at("20:02"), scheduledEnd: at("18:30"), link: "https://x/l" }),
    "Hi Devin — Rezku shows you clocked out at 8:02 PM on Mon 10/5; you were scheduled until 6:30 PM. If you forgot to clock out, tap to enter when you left (or confirm it's right): https://x/l Reply STOP to opt out.",
  );
});

test("Rezku texts stop 48 hours after the clock-out", () => {
  const dueAt = at("20:02");
  const base = { dueAt, smsOptIn: true, phone: "3155550100", active: true, maxLatenessHours: REZKU_SMS_MAX_AGE_HOURS };
  assert.deepEqual(missedClockOutSmsPlan({ ...base, now: new Date(dueAt.getTime() + 47 * 3_600_000) }), { send: true });
  assert.deepEqual(missedClockOutSmsPlan({ ...base, now: new Date(dueAt.getTime() + 49 * 3_600_000) }), { send: false, reason: "too_late" });
});

test("Rezku names match employees like payroll does", () => {
  const people = [{ id: "1", name: "Ken", active: true }, { id: "2", name: "Devin  Smith", active: true }, { id: "3", name: "Devin Smith", active: false }, { id: "4", name: "Alex", active: true }, { id: "5", name: "alex", active: true }];
  assert.equal(matchEmployeeByName("Can", people)?.id, "1");
  assert.equal(matchEmployeeByName("devin smith", people)?.id, "2");
  assert.equal(matchEmployeeByName("Alex", people), null); // two active Alexes: don't guess
  assert.equal(matchEmployeeByName("Cover", people), null);
  assert.equal(matchEmployeeByName("Nobody", people), null);
});

test("which cases hold up approval", () => {
  assert.equal(caseBlocksApproval("open_punch", "Open"), true);
  assert.equal(caseBlocksApproval("auto_closed", "AutoClosed"), false);
  assert.equal(caseBlocksApproval("late_clock_out", "Open"), false);
  assert.equal(caseBlocksApproval("late_clock_out", "Submitted"), true);
  assert.equal(caseBlocksApproval("unscheduled", "Open"), false);
  assert.equal(caseBlocksApproval("open_punch", "Resolved"), false);
});

test("owner email groups the kinds", () => {
  const email = missedClockOutOwnerEmail({
    business: "Corner Deli",
    cases: [
      { kind: "auto_closed", employeeName: "Sam", clockIn: at("10:00"), scheduledEnd: at("18:30"), punchClockOut: at("18:30"), autoCloseBasis: "scheduled_end", smsNote: "Texted", link: "https://x/1" },
      { kind: "late_clock_out", employeeName: "Devin", clockIn: at("10:27"), scheduledEnd: at("18:30"), punchClockOut: at("20:02"), smsNote: "Texted", link: "https://x/2" },
      { kind: "unscheduled", employeeName: "Pat", clockIn: at("11:00"), scheduledEnd: null, punchClockOut: at("13:30"), smsNote: "", link: "https://x/3" },
    ],
  });
  assert.equal(email.subject, "Corner Deli: 3 clock-outs to check");
  assert.match(email.text, /closed automatically[\s\S]*Sam\n  Clocked in: Mon, Oct 5, 10:00 AM\n  Closed at: Mon, Oct 5, 6:30 PM \(scheduled end\)/);
  assert.match(email.text, /Devin\n  Rezku: Mon, Oct 5, 10:27 AM to 8:02 PM\n  Scheduled until: 6:30 PM/);
  assert.match(email.text, /Worked without a scheduled shift \(not texted\):\n\nPat/);
  assert.match(email.text, /keep as is\): https:\/\/x\/2/);
});
