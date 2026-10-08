/**
 * Pure rules for missed clock-outs and the Monday payroll approval: when a
 * business day closes, when an open punch becomes a case, which times an
 * employee or owner may enter, and the text of the texts and emails. No
 * database or network access here, so it is unit tested directly.
 */
import type { Business } from "@/lib/types";

export const BUSINESS_TIME_ZONE = "America/New_York";
/** A case is created this long after the business day's close. */
export const MISSED_CLOCK_OUT_GRACE_MINUTES = 60;
/** Longest shift an employee may report; also the close used when nothing else is known. */
export const MAX_EMPLOYEE_SHIFT_HOURS = 16;
/** Owners may enter a longer shift than employees (double shifts, events). */
export const MAX_OWNER_SHIFT_HOURS = 24;
/** Open punches found later than this after their close get a case and an owner email, but no text. */
export const SMS_MAX_LATENESS_HOURS = 24;
/** An employee's phone clock may run a little ahead of the server. */
const FUTURE_TOLERANCE_MS = 2 * 60_000;

export type CloseBasis = "business_close" | "scheduled_end" | "max_shift";

/** One configured opening for a business date, as PostgreSQL TIME text ("21:30:00"). */
export type HoursWindow = { opens: string; closes: string };

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date: Date, timeZone = BUSINESS_TIME_ZONE): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    weekday: WEEKDAYS[values.weekday] ?? 0,
  };
}

/** Local calendar date ("2026-10-08") of an instant in the business time zone. */
export function localDateKey(date: Date, timeZone = BUSINESS_TIME_ZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Day of week (0 = Sunday) of a calendar date. */
export function weekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The instant a wall-clock time happens in the business time zone. A time in
 * the fall-back hour is its first (daylight) occurrence; a time inside the
 * spring-forward gap (which never happens on the clock) lands within an hour of it.
 */
export function wallTimeToUtc(dateKey: string, minuteOfDay: number, timeZone = BUSINESS_TIME_ZONE): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = desired;
  for (let count = 0; count < 4; count += 1) {
    const observed = zonedParts(new Date(guess), timeZone);
    const delta = desired - Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

export function timeTextMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * When a business date's last opening closes. A close at or before its open
 * runs past midnight and lands on the next calendar date. Null when the date
 * has no openings (closed, or no hours configured).
 */
export function businessDayCloseUtc(dateKey: string, windows: HoursWindow[], timeZone = BUSINESS_TIME_ZONE): Date | null {
  let latest: Date | null = null;
  for (const window of windows) {
    const open = timeTextMinutes(window.opens);
    const close = timeTextMinutes(window.closes);
    if (open === null || close === null) continue;
    const closeDate = close <= open ? addDays(dateKey, 1) : dateKey;
    const closeAt = wallTimeToUtc(closeDate, close, timeZone);
    if (!latest || closeAt > latest) latest = closeAt;
  }
  return latest;
}

export type CloseResolution = {
  basis: CloseBasis;
  /** The business date the punch belongs to. */
  businessDate: string;
  closeAt: Date;
  /** When the punch becomes a missed clock-out case. */
  dueAt: Date;
};

/**
 * Which close applies to an open punch. A punch belongs to the earliest of the
 * previous or current business day whose close is at or after the clock-in, so
 * a 12:30 AM clock-in during a 6 PM–2 AM night counts toward that night. With
 * no business close (no hours configured, closed that day, or clocked in after
 * close) the employee's published shift end is used, and failing that the
 * longest allowed shift.
 */
export function resolveMissedClockOutClose(input: {
  clockIn: Date;
  /** Business-day close for the clock-in's local date and the day before (null when not open / not configured). */
  closes: Array<{ businessDate: string; closeAt: Date | null }>;
  scheduledEnd: Date | null;
  graceMinutes?: number;
  timeZone?: string;
}): CloseResolution {
  const grace = (input.graceMinutes ?? MISSED_CLOCK_OUT_GRACE_MINUTES) * 60_000;
  const candidates = input.closes
    .filter((item): item is { businessDate: string; closeAt: Date } => Boolean(item.closeAt) && item.closeAt!.getTime() >= input.clockIn.getTime())
    .sort((a, b) => a.closeAt.getTime() - b.closeAt.getTime());
  const clockInDate = localDateKey(input.clockIn, input.timeZone);
  if (candidates[0]) {
    return { basis: "business_close", businessDate: candidates[0].businessDate, closeAt: candidates[0].closeAt, dueAt: new Date(candidates[0].closeAt.getTime() + grace) };
  }
  if (input.scheduledEnd && input.scheduledEnd.getTime() >= input.clockIn.getTime()) {
    return { basis: "scheduled_end", businessDate: clockInDate, closeAt: input.scheduledEnd, dueAt: new Date(input.scheduledEnd.getTime() + grace) };
  }
  const closeAt = new Date(input.clockIn.getTime() + MAX_EMPLOYEE_SHIFT_HOURS * 3_600_000);
  return { basis: "max_shift", businessDate: clockInDate, closeAt, dueAt: new Date(closeAt.getTime() + grace) };
}

export type MissedClockOutDecision = "not_due" | "already_handled" | "closed" | "create";

/** Each open punch is handled once: a case is created only when due and none exists yet. */
export function missedClockOutDecision(input: { now: Date; dueAt: Date; hasCase: boolean; clockedOut: boolean }): MissedClockOutDecision {
  if (input.clockedOut) return "closed";
  if (input.hasCase) return "already_handled";
  if (input.now.getTime() < input.dueAt.getTime()) return "not_due";
  return "create";
}

export type SmsPlan = { send: true } | { send: false; reason: "not_opted_in" | "no_phone" | "too_late" | "inactive" };

/** Text only employees who consented and have a phone, and only near the close (not for long-stale punches). */
export function missedClockOutSmsPlan(input: { now: Date; dueAt: Date; smsOptIn: boolean; phone: string; active: boolean }): SmsPlan {
  if (!input.active) return { send: false, reason: "inactive" };
  if (!input.smsOptIn) return { send: false, reason: "not_opted_in" };
  if (!String(input.phone || "").replace(/\D/g, "")) return { send: false, reason: "no_phone" };
  if (input.now.getTime() - input.dueAt.getTime() > SMS_MAX_LATENESS_HOURS * 3_600_000) return { send: false, reason: "too_late" };
  return { send: true };
}

/**
 * Parses a time someone typed in the browser: a datetime-local value
 * ("2026-10-08T21:45") is Eastern wall time; a full ISO string is taken as is.
 */
export function parseEasternInput(value: string, timeZone = BUSINESS_TIME_ZONE): Date | null {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const direct = new Date(text);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(text);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return wallTimeToUtc(match[1], hour * 60 + minute, timeZone);
}

/** Error message for a reported clock-out time, or null when it is acceptable. */
export function clockOutTimeProblem(input: { clockIn: Date; clockOut: Date | null; now: Date; maxHours?: number }): string | null {
  const maxHours = input.maxHours ?? MAX_EMPLOYEE_SHIFT_HOURS;
  if (!input.clockOut || Number.isNaN(input.clockOut.getTime())) return "Enter the date and time you left.";
  if (input.clockOut.getTime() <= input.clockIn.getTime()) return "The time you left has to be after you clocked in.";
  if (input.clockOut.getTime() > input.now.getTime() + FUTURE_TOLERANCE_MS) return "That time is in the future.";
  if (input.clockOut.getTime() - input.clockIn.getTime() > maxHours * 3_600_000) return `That would be a shift longer than ${maxHours} hours. Check the date.`;
  return null;
}

export function formatTime(date: Date, timeZone = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

/** "10:02 AM" on the same local day as `now`, otherwise "Fri 10:02 AM". */
export function formatTimeNear(date: Date, now: Date, timeZone = BUSINESS_TIME_ZONE): string {
  if (localDateKey(date, timeZone) === localDateKey(now, timeZone)) return formatTime(date, timeZone);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return `${day} ${formatTime(date, timeZone)}`;
}

export function formatDateTime(date: Date, timeZone = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function firstName(name: string): string {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

export function missedClockOutSmsText(input: { employeeName: string; business: Business; clockIn: Date; now: Date; link: string }): string {
  return `Hi ${firstName(input.employeeName)} — you're still clocked in at ${input.business} since ${formatTimeNear(input.clockIn, input.now)}. `
    + `If you forgot to clock out, tap to enter when you left: ${input.link} Reply STOP to opt out.`;
}

const CLOSE_LABELS: Record<CloseBasis, string> = {
  business_close: "business close",
  scheduled_end: "scheduled shift end",
  max_shift: `${MAX_EMPLOYEE_SHIFT_HOURS} hours after clock-in`,
};

export function closeBasisLabel(basis: CloseBasis): string {
  return CLOSE_LABELS[basis] || basis;
}

export type OwnerCaseLine = {
  employeeName: string;
  clockIn: Date;
  scheduledEnd: Date | null;
  smsNote: string;
  link: string;
};

/** One owner email per business per run, listing the newly found open punches. */
export function missedClockOutOwnerEmail(input: { business: Business; cases: OwnerCaseLine[] }): { subject: string; text: string } {
  const count = input.cases.length;
  const lines = input.cases.flatMap((item) => [
    `${item.employeeName}`,
    `  Clocked in: ${formatDateTime(item.clockIn)}`,
    `  Scheduled end: ${item.scheduledEnd ? formatDateTime(item.scheduledEnd) : "No published shift"}`,
    `  Text to employee: ${item.smsNote}`,
    `  Choose the clock-out (use scheduled end, use their time, or enter one): ${item.link}`,
    "",
  ]);
  return {
    subject: `${input.business}: ${count} employee${count === 1 ? " is" : "s are"} still clocked in`,
    text: [
      `These ${input.business} punches were still open an hour after close:`,
      "",
      ...lines,
      "Opening a link changes nothing. You sign in and tap the clock-out to use; it is saved as an audited punch correction.",
    ].join("\n"),
  };
}

export function employeeLeftAtOwnerEmail(input: { business: Business; employeeName: string; leftAt: Date; clockIn: Date; note: string; link: string }): { subject: string; text: string } {
  const name = String(input.employeeName || "").trim() || "An employee";
  return {
    subject: `${name} says they left at ${formatTime(input.leftAt)}`,
    text: [
      `${name} (${input.business}) forgot to clock out and says they left at ${formatDateTime(input.leftAt)}.`,
      `Clocked in: ${formatDateTime(input.clockIn)}`,
      input.note ? `Their note: ${input.note}` : "",
      "",
      `Approve or change it: ${input.link}`,
      "Nothing changes until you approve it.",
    ].filter((line, index, all) => line || all[index - 1] !== "").join("\n"),
  };
}

export type ApprovalBlockers = {
  openPunches: number;
  unresolvedClockOuts: number;
};

/** Why a payroll week cannot be approved yet, or null when it can. */
export function payrollApprovalBlockMessage(blockers: ApprovalBlockers): string | null {
  const parts: string[] = [];
  if (blockers.openPunches) parts.push(`${blockers.openPunches} open punch${blockers.openPunches === 1 ? "" : "es"}`);
  if (blockers.unresolvedClockOuts) parts.push(`${blockers.unresolvedClockOuts} missed clock-out${blockers.unresolvedClockOuts === 1 ? "" : "s"} to resolve`);
  if (!parts.length) return null;
  return `Payroll can't be approved yet: this week still has ${parts.join(" and ")}. Close or correct them first.`;
}

export type PayrollEmailRow = { employee: string; hours: number; regularHours: number; overtimeHours: number; tips: number };

const hoursText = (value: number) => Number(value || 0).toFixed(2);
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));

export function payrollApprovalEmail(input: {
  business: Business;
  weekStart: string;
  rows: PayrollEmailRow[];
  draft: { version: number; created: boolean } | { error: string };
  blockers: ApprovalBlockers;
  missingSquareFees: number;
  needsReview: number;
  reviewLink: string;
}): { subject: string; text: string } {
  const totals = input.rows.reduce((sum, row) => ({
    hours: sum.hours + Number(row.hours || 0),
    regular: sum.regular + Number(row.regularHours || 0),
    overtime: sum.overtime + Number(row.overtimeHours || 0),
    tips: sum.tips + Number(row.tips || 0),
  }), { hours: 0, regular: 0, overtime: 0, tips: 0 });
  const weekEnd = addDays(input.weekStart, 6);
  const blocking = payrollApprovalBlockMessage(input.blockers);
  const attention: string[] = [];
  if (input.blockers.openPunches) attention.push(`- ${input.blockers.openPunches} open punch${input.blockers.openPunches === 1 ? "" : "es"} (blocks approval)`);
  if (input.blockers.unresolvedClockOuts) attention.push(`- ${input.blockers.unresolvedClockOuts} missed clock-out${input.blockers.unresolvedClockOuts === 1 ? "" : "s"} not resolved (blocks approval)`);
  if (input.missingSquareFees) attention.push(`- ${input.missingSquareFees} Square payment${input.missingSquareFees === 1 ? "" : "s"} missing processing fees`);
  if (input.needsReview) attention.push(`- ${input.needsReview} punch${input.needsReview === 1 ? "" : "es"} marked Needs Review`);
  if ("error" in input.draft) attention.push(`- The payroll draft could not be created: ${input.draft.error}`);
  const draftLine = "error" in input.draft
    ? "No draft was created."
    : `Draft v${input.draft.version} ${input.draft.created ? "was created" : "already existed"}.`;
  const table = input.rows.length
    ? input.rows.map((row) => `${row.employee}: ${hoursText(row.hours)} h (${hoursText(row.regularHours)} reg, ${hoursText(row.overtimeHours)} OT), tips ${money(row.tips)}`)
    : ["No hours recorded."];
  return {
    subject: `${input.business} payroll for ${input.weekStart} – ${weekEnd}: ${blocking ? "needs attention" : "ready to approve"}`,
    text: [
      `${input.business} payroll, week of ${input.weekStart} through ${weekEnd}. ${draftLine}`,
      "",
      ...table,
      "",
      `Totals: ${hoursText(totals.hours)} h (${hoursText(totals.regular)} regular, ${hoursText(totals.overtime)} OT), tips ${money(totals.tips)}`,
      "",
      attention.length ? "Needs attention:" : "Nothing is blocking approval.",
      ...attention,
      "",
      `Review and approve: ${input.reviewLink}`,
      "Approving locks this payroll and queues it to be sent to AccountantsOffice.",
    ].join("\n"),
  };
}

export type SubmissionStatus = "queued" | "submitting" | "submitted" | "failed" | "cancelled";

/** The status line shown on the payroll page for a locked run's submission. */
export function submissionStatusLine(status: SubmissionStatus | string | null | undefined, message = ""): string {
  if (status === "queued") return "Waiting to send to AccountantsOffice";
  if (status === "submitting") return "Sending to AccountantsOffice…";
  if (status === "submitted") return message ? `Sent to AccountantsOffice: ${message}` : "Sent to AccountantsOffice";
  if (status === "failed") return `Failed: ${message || "AccountantsOffice did not accept it."}`;
  if (status === "cancelled") return "Not sent (payroll was reopened)";
  return "";
}

export function payrollSubmissionEmail(input: { business: Business; weekStart: string; version: number; status: "submitted" | "failed"; message: string; link: string }): { subject: string; text: string } {
  const ok = input.status === "submitted";
  return {
    subject: ok
      ? `${input.business} payroll for ${input.weekStart} was sent to AccountantsOffice`
      : `${input.business} payroll for ${input.weekStart} could not be sent to AccountantsOffice`,
    text: [
      ok
        ? `Payroll v${input.version} for ${input.business}, week of ${input.weekStart}, was submitted to AccountantsOffice.`
        : `Payroll v${input.version} for ${input.business}, week of ${input.weekStart}, was not submitted to AccountantsOffice.`,
      input.message ? `${ok ? "Details" : "Reason"}: ${input.message}` : "",
      "",
      `Payroll: ${input.link}`,
    ].filter((line, index) => line || index > 1).join("\n"),
  };
}
