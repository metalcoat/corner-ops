/** Call-outs at least this many hours before the shift starts are on time (handbook section 3). */
export const CALL_OUT_NOTICE_HOURS = 4;

export function isLateCallOut(shiftStartsAt: Date, now = new Date()): boolean {
  return shiftStartsAt.getTime() - now.getTime() < CALL_OUT_NOTICE_HOURS * 60 * 60 * 1000;
}

export function coverageShiftLabel(startsAt: Date, endsAt: Date, position: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(startsAt);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return `${day}, ${time.format(startsAt)}–${time.format(endsAt)}${position ? ` · ${position}` : ""}`;
}

/** The one group message. Never says why; sick leave stays private. */
export function coverageGroupMessage(input: { shift: string }): string {
  return `I need coverage: ${input.shift}. Can anyone take it? Tap "I'll take it" under Schedule → Shifts needing coverage.`;
}
