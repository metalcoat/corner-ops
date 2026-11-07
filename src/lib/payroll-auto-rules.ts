/**
 * Pure timing and decision rules for Monday payroll (Corner Deli):
 *   8:00 AM Eastern  the summary email (waits for Sunday's punches until 12:00 PM)
 *   5:00 PM Eastern  automatic approval, which queues the AccountantsOffice submission,
 *                    unless the week is on Hold or something blocks it
 * plus the emails' wording. No database or network access here, so it is unit
 * tested directly. Payroll week = Monday 4 AM → next Monday 4 AM, America/New_York.
 */
import type { Business } from "@/lib/types";
import {
  addDays,
  formatTime,
  localDateKey,
  payrollEmailTable,
  payrollWeekLabel,
  wallTimeToUtc,
  weekdayOf,
  type PayrollEmailRow,
} from "./missed-clock-out-rules";

export const SUMMARY_HOUR = 8;
/** If Sunday's punches haven't arrived, the summary waits until this hour, then goes out with a warning. */
export const SUNDAY_FALLBACK_HOUR = 12;
export const AUTO_SEND_HOUR = 17;
/** A summary that only went out at or after this hour (an outage) is too late to warn the owner, so nothing is sent automatically. */
export const LATE_SUMMARY_HOUR = 15;
export const AUTO_APPROVAL_ACTOR = "Automatic 5 PM approval";
export const SUNDAY_MISSING_WARNING = "Sunday's hours haven't arrived yet";

const minutes = (hour: number) => hour * 60;

/** The Monday a payroll week ends on (its 4 AM is the end of the week). */
export function payrollMonday(weekStart: string): string {
  return addDays(weekStart, 7);
}

/** Every moment that matters for one payroll week's Monday, as instants (DST-correct). */
export function payrollMondaySchedule(weekStart: string) {
  const monday = payrollMonday(weekStart);
  const sunday = addDays(weekStart, 6);
  return {
    monday,
    sunday,
    weekEnd: wallTimeToUtc(monday, minutes(4)),
    summaryAt: wallTimeToUtc(monday, minutes(SUMMARY_HOUR)),
    sundayFallbackAt: wallTimeToUtc(monday, minutes(SUNDAY_FALLBACK_HOUR)),
    lateSummaryAt: wallTimeToUtc(monday, minutes(LATE_SUMMARY_HOUR)),
    autoSendAt: wallTimeToUtc(monday, minutes(AUTO_SEND_HOUR)),
    /** Tuesday 11:59 PM is the last moment (Wednesday 00:00 closes it). */
    windowEnd: wallTimeToUtc(addDays(monday, 2), 0),
    /** Sunday's payroll day: Sunday 4 AM → Monday 4 AM. */
    sundayStart: wallTimeToUtc(sunday, minutes(4)),
    sundayEnd: wallTimeToUtc(monday, minutes(4)),
  };
}

/** The payroll week whose Monday is today or most recently passed (Eastern), i.e. the week Monday's jobs are about. */
export function mondayJobWeek(now: Date): string {
  const today = localDateKey(now);
  const sinceMonday = (weekdayOf(today) + 6) % 7;
  return addDays(today, -sinceMonday - 7);
}

export type SummaryAction = "too_early" | "wait_for_sunday" | "send" | "window_closed" | "already_sent" | "already_approved";

/**
 * When the Monday summary goes out: from 8:00 AM, once. If the week has published shifts on Sunday but no
 * Sunday punches yet (Rezku's report often arrives Monday morning), it waits (re-checked every 15 minutes)
 * until punches appear or 12:00 PM, when it goes out anyway with a prominent warning.
 */
export function summaryDecision(input: {
  now: Date;
  weekStart: string;
  sundayScheduledShifts: number;
  sundayPunches: number;
  alreadySent: boolean;
  approved?: boolean;
}): { action: SummaryAction; sundayMissing: boolean } {
  const s = payrollMondaySchedule(input.weekStart);
  const sundayMissing = input.sundayScheduledShifts > 0 && input.sundayPunches === 0;
  const t = input.now.getTime();
  if (input.alreadySent) return { action: "already_sent", sundayMissing };
  if (t < s.summaryAt.getTime()) return { action: "too_early", sundayMissing };
  if (t >= s.windowEnd.getTime()) return { action: "window_closed", sundayMissing };
  if (input.approved) return { action: "already_approved", sundayMissing };
  if (sundayMissing && t < s.sundayFallbackAt.getTime()) return { action: "wait_for_sunday", sundayMissing };
  return { action: "send", sundayMissing };
}

/** A summary sent at or after 3 PM Monday doesn't give the owner time to Hold, so that week isn't sent automatically. */
export function summaryWasLate(weekStart: string, sentAt: Date | null): boolean {
  return Boolean(sentAt && sentAt.getTime() >= payrollMondaySchedule(weekStart).lateSummaryAt.getTime());
}

export type AutoSendAction = "too_early" | "window_closed" | "already_decided" | "already_approved" | "approve" | "not_sent";

/**
 * The 5:00 PM automatic approval (window Monday 5:00 PM → Tuesday 11:59 PM, decided once per week):
 * approve when the latest version isn't already approved, the week isn't on hold, was never approved and
 * reopened, the 8 AM summary went out in time, Sunday's hours are in, and nothing blocks approval.
 * Otherwise "not_sent" with the reasons (emailed once). Manual approval before 5 PM simply wins.
 */
export function autoSendDecision(input: {
  now: Date;
  weekStart: string;
  /** Status of the week's latest payroll version (null when there is none yet). */
  latestStatus: "Draft" | "Locked" | null;
  /** Some version of this week was approved (locked) before: reopened payroll is never re-sent automatically. */
  everLocked: boolean;
  /** Who put the week on hold, or null. */
  heldBy: string | null;
  /** When the 8 AM summary email went out (null: never). */
  summarySentAt: Date | null;
  sundayMissing: boolean;
  /** Approval blockers (open punches, missed clock-outs), already worded. */
  blockers: string[];
  /** The 5 PM decision for this week was already made. */
  decided: boolean;
}): { action: AutoSendAction; reasons: string[] } {
  const s = payrollMondaySchedule(input.weekStart);
  const t = input.now.getTime();
  if (t < s.autoSendAt.getTime()) return { action: "too_early", reasons: [] };
  if (input.decided) return { action: "already_decided", reasons: [] };
  if (input.latestStatus === "Locked") return { action: "already_approved", reasons: [] };
  if (t >= s.windowEnd.getTime()) return { action: "window_closed", reasons: [] };
  const reasons: string[] = [];
  if (input.heldBy) reasons.push(`it's on hold (by ${input.heldBy})`);
  if (input.everLocked) reasons.push("it was approved and then reopened");
  if (!input.summarySentAt) reasons.push("the 8 AM summary email wasn't sent");
  else if (summaryWasLate(input.weekStart, input.summarySentAt)) reasons.push(`the summary email only went out at ${formatTime(input.summarySentAt)}`);
  if (input.sundayMissing) reasons.push(SUNDAY_MISSING_WARNING.charAt(0).toLowerCase() + SUNDAY_MISSING_WARNING.slice(1));
  reasons.push(...input.blockers.filter(Boolean));
  return reasons.length ? { action: "not_sent", reasons } : { action: "approve", reasons: [] };
}

/** Approval blockers as short reasons ("2 open punches"). */
export function blockerReasons(blockers: { openPunches: number; unresolvedClockOuts: number }): string[] {
  const out: string[] = [];
  if (blockers.openPunches) out.push(`${blockers.openPunches} open punch${blockers.openPunches === 1 ? "" : "es"}`);
  if (blockers.unresolvedClockOuts) out.push(`${blockers.unresolvedClockOuts} missed clock-out${blockers.unresolvedClockOuts === 1 ? "" : "s"} to resolve`);
  return out;
}

const round2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

/**
 * What decides whether a recalculated payroll differs from the latest draft: each employee's hours and
 * tips (what is entered in Payroll Relief) and the scheduled-vs-worked lines (what the email shows).
 */
export function payrollSummaryFingerprint(summary: {
  rows?: Array<{ employee: string; hours?: number; regularHours?: number; overtimeHours?: number; driverTipHours?: number; tips?: number }>;
  scheduleComparison?: Array<{ employee: string; text?: string; flagged?: boolean }>;
} | null | undefined): string {
  const rows = (summary?.rows || [])
    .map((row) => [String(row.employee || "").trim().toLowerCase(), round2(row.hours || 0), round2(row.regularHours || 0), round2(row.overtimeHours || 0), round2(row.driverTipHours || 0), round2(row.tips || 0)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const schedule = (summary?.scheduleComparison || [])
    .map((row) => [String(row.employee || "").trim().toLowerCase(), String(row.text || ""), Boolean(row.flagged)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({ rows, schedule });
}

// ---------------------------------------------------------------------------
// Email wording

/** "Sun 10/11 10:00 AM–4:00 PM". */
export function shiftWindowText(startsAt: string | Date, endsAt: string | Date): string {
  const start = new Date(startsAt), end = new Date(endsAt);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" }).format(start).replace(",", "");
  return `${day} ${formatTime(start)}–${formatTime(end)}`;
}

export type SummaryScheduleRow = PayrollEmailRow & {
  schedule: (PayrollEmailRow["schedule"] & { missed?: Array<{ startsAt: string; endsAt: string }>; untracked?: boolean }) | null;
};

/** The "What's off from the schedule" lines: flagged employees with their missed shifts' day and time, then salaried ones. */
export function scheduleOffLines(rows: SummaryScheduleRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const s = row.schedule;
    if (!s || s.untracked || !s.flagged) continue;
    lines.push(`- ${row.employee}: ${s.text}`);
    for (const missed of s.missed || []) lines.push(`    Missed: ${shiftWindowText(missed.startsAt, missed.endsAt)}`);
  }
  if (!lines.length) lines.push("Everyone worked within an hour of their schedule, with no missed shifts.");
  const untracked = rows.filter((row) => row.schedule?.untracked).map((row) => row.employee);
  if (untracked.length) lines.push(`Not tracked (salaried): ${untracked.join(", ")}`);
  return lines;
}

/** The 8:00 AM Monday summary. Opening its links changes nothing: Hold is a button on the payroll page. */
export function payrollMondaySummaryEmail(input: {
  business: Business;
  weekStart: string;
  rows: SummaryScheduleRow[];
  draft: { version: number; created: boolean } | { error: string };
  blockers: string[];
  missingSquareFees: number;
  needsReview: number;
  /** Closed automatically, or late / unscheduled in Rezku: listed, not blocking. */
  clockOutsToCheck?: number;
  sundayMissing: boolean;
  /** Corner Deli: sent to AccountantsOffice automatically at 5 PM. */
  autoSend: boolean;
  /** The email is going out at or after 3 PM (an outage): no automatic send this week. */
  late: boolean;
  reviewLink: string;
  holdLink: string;
}): { subject: string; text: string } {
  const week = payrollWeekLabel(input.weekStart);
  const draftLine = "error" in input.draft
    ? `No draft could be created: ${input.draft.error}`
    : `Draft v${input.draft.version} (${input.draft.created ? "recalculated this morning" : "unchanged since it was last calculated"}).`;
  const attention: string[] = input.blockers.map((reason) => `- ${reason} (blocks approval)`);
  if (input.missingSquareFees) attention.push(`- ${input.missingSquareFees} Square payment${input.missingSquareFees === 1 ? "" : "s"} missing processing fees`);
  if (input.needsReview) attention.push(`- ${input.needsReview} punch${input.needsReview === 1 ? "" : "es"} marked Needs Review`);
  if (input.clockOutsToCheck) attention.push(`- ${input.clockOutsToCheck} clock-out${input.clockOutsToCheck === 1 ? "" : "s"} to check (closed automatically, or late in Rezku; these don't block)`);
  const blocked = input.blockers.length > 0 || input.sundayMissing || "error" in input.draft;
  const sendLines: string[] = [];
  if (input.autoSend && !input.late) {
    sendLines.push("This will be sent to AccountantsOffice automatically at 5:00 PM today unless you put it on Hold or something blocks it.");
    if (blocked) sendLines.push("Right now something blocks it (see above): fix it before 5:00 PM, or approve on the payroll page when ready.");
  } else if (input.autoSend) {
    sendLines.push("This summary went out late, so it won't be sent to AccountantsOffice automatically today. Approve it on the payroll page when ready.");
  } else {
    sendLines.push("The Docks isn't sent to AccountantsOffice automatically. Approve it on the payroll page when ready.");
  }
  const subjectState = input.sundayMissing
    ? SUNDAY_MISSING_WARNING
    : blocked ? "needs attention" : input.autoSend && !input.late ? "sends to AccountantsOffice at 5 PM" : "ready to approve";
  return {
    subject: `${input.business} payroll ${week}: ${subjectState}`,
    text: [
      ...(input.sundayMissing ? [
        `*** ${SUNDAY_MISSING_WARNING.toUpperCase()} ***`,
        "Sunday has scheduled shifts but no punches yet (Rezku's report may still be on its way). The hours below leave Sunday out, and it won't be sent automatically until they arrive.",
        "",
      ] : []),
      `${input.business} payroll, week of ${week}. ${draftLine}`,
      "",
      ...payrollEmailTable(input.rows),
      "",
      "What's off from the schedule:",
      ...scheduleOffLines(input.rows),
      "",
      attention.length ? "Needs attention:" : "Nothing is blocking approval.",
      ...attention,
      "",
      ...sendLines,
      "",
      `Review: ${input.reviewLink}`,
      ...(input.autoSend && !input.late ? [`Hold (opens the payroll page; press Hold there): ${input.holdLink}`] : []),
    ].join("\n"),
  };
}

/** Sent once when the 5 PM automatic send didn't happen. */
export function autoSendSkippedEmail(input: { business: Business; weekStart: string; reasons: string[]; link: string }): { subject: string; text: string } {
  const week = payrollWeekLabel(input.weekStart);
  return {
    subject: `${input.business} payroll ${week} was not sent at 5 PM`,
    text: [
      `Not sent at 5 PM: ${input.reasons.join("; ")} — approve on the payroll page when ready.`,
      "",
      `Payroll page: ${input.link}`,
    ].join("\n"),
  };
}
