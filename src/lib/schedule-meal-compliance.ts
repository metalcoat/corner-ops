const TIME_ZONE = "America/New_York";
const MINUTE_MS = 60_000;
const RUSH_START = "17:00";
const RUSH_END = "19:30";

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export type MealScheduleInput = {
  startsAt: string;
  endsAt: string;
  business?: string | null;
  position?: string | null;
  mealBreakStart?: string | null;
  mealBreakMinutes?: number | null;
  extraMealBreakStart?: string | null;
  extraMealBreakMinutes?: number | null;
};

export type MealRequirement = {
  code: "general-six-hour" | "noon-meal" | "late-shift" | "extra-evening";
  slot: "primary" | "extra";
  minimumMinutes: number;
  label: string;
  detail: string;
  suggestedStart: string;
  windowStart?: string;
  windowEnd?: string;
  midpoint?: string;
};

export type MealComplianceIssue = {
  code: string;
  slot: "primary" | "extra";
  message: string;
};

const partFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function partsFor(date: Date): DateParts {
  const values = Object.fromEntries(
    partFormatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function newYorkDateKey(value: Date | string): string {
  const parts = partsFor(value instanceof Date ? value : new Date(value));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function newYorkTimeValue(value: Date | string): string {
  const parts = partsFor(value instanceof Date ? value : new Date(value));
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function newYorkDateTime(dateKey: string, timeValue: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const time = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match || !time) throw new Error("Date or time is invalid.");
  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(time[1]),
    minute: Number(time[2]),
  };
  if (target.hour > 23 || target.minute > 59) throw new Error("Time is invalid.");

  let utc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = partsFor(new Date(utc));
    const wantedStamp = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
    const observedStamp = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const delta = wantedStamp - observedStamp;
    if (!delta) break;
    utc += delta;
  }
  return new Date(utc);
}

function dateKeyPlus(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateKeysBetween(start: Date, end: Date): string[] {
  const first = newYorkDateKey(start);
  const last = newYorkDateKey(end);
  const result: string[] = [];
  let current = first;
  for (let index = 0; index < 4; index += 1) {
    result.push(current);
    if (current === last) break;
    current = dateKeyPlus(current, 1);
  }
  return result;
}

function minutesOfDay(date: Date): number {
  const parts = partsFor(date);
  return parts.hour * 60 + parts.minute;
}

function roundDownQuarter(value: number): number {
  return Math.floor(value / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
}

function roundUpQuarter(value: number): number {
  return Math.ceil(value / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function overlapsDinnerRush(startMs: number, endMs: number): boolean {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return dateKeysBetween(start, end).some((key) => {
    const rushStart = newYorkDateTime(key, RUSH_START).getTime();
    const rushEnd = newYorkDateTime(key, RUSH_END).getTime();
    return startMs < rushEnd && endMs > rushStart;
  });
}

function rushAwareSuggestedStart(
  earliestStartMs: number,
  latestStartMs: number,
  midpointMs: number,
  minimumMinutes: number,
): number {
  const breakMs = minimumMinutes * MINUTE_MS;
  const targetStart = midpointMs - breakMs / 2;
  const candidates: number[] = [];
  for (let value = roundUpQuarter(earliestStartMs); value <= roundDownQuarter(latestStartMs); value += 15 * MINUTE_MS) {
    candidates.push(value);
  }
  if (!candidates.length) return clamp(roundDownQuarter(targetStart), earliestStartMs, latestStartMs);

  const outsideRush = candidates.filter((value) => !overlapsDinnerRush(value, value + breakMs));
  const choices = outsideRush.length ? outsideRush : candidates;
  choices.sort((left, right) => Math.abs(left - targetStart) - Math.abs(right - targetStart) || left - right);
  return choices[0];
}

function midpointRequirement(
  code: "general-six-hour" | "late-shift",
  start: Date,
  end: Date,
  minimumMinutes: number,
): MealRequirement {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const durationMs = endMs - startMs;
  const midpointMs = startMs + durationMs / 2;

  if (code === "late-shift") {
    const windowStartMs = startMs + durationMs / 4;
    const windowEndMs = endMs - durationMs / 4;
    const latestStartMs = windowEndMs - minimumMinutes * MINUTE_MS;
    const suggestedMs = rushAwareSuggestedStart(
      windowStartMs,
      latestStartMs,
      midpointMs,
      minimumMinutes,
    );
    return {
      code,
      slot: "primary",
      minimumMinutes,
      label: "30-minute shortened late-shift meal",
      detail: "For a shift over six hours starting between 1 PM and 6 AM, Corner Ops accepts a 30-minute off-duty meal within the middle half of the shift. It avoids the 5:00–7:30 PM rush when another compliant slot is available. New York permits shortening the statutory 45-minute period to at least 30 minutes when there is no indication of hardship to the employee.",
      suggestedStart: new Date(suggestedMs).toISOString(),
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
    };
  }

  const suggestedMs = roundDownQuarter(midpointMs - minimumMinutes * MINUTE_MS / 2);
  return {
    code,
    slot: "primary",
    minimumMinutes,
    label: "30-minute meal",
    detail: "Company compliance policy requires at least 30 off-duty minutes around the middle of every shift over six hours.",
    suggestedStart: new Date(suggestedMs).toISOString(),
    midpoint: new Date(midpointMs).toISOString(),
  };
}

function noonRequirement(start: Date, end: Date): MealRequirement | null {
  if (end.getTime() - start.getTime() <= 360 * MINUTE_MS) return null;
  for (const key of dateKeysBetween(start, end)) {
    const windowStart = newYorkDateTime(key, "11:00");
    const windowEnd = newYorkDateTime(key, "14:00");
    const overlapStart = Math.max(start.getTime(), windowStart.getTime());
    const overlapEnd = Math.min(end.getTime(), windowEnd.getTime());
    if (overlapEnd - overlapStart >= 30 * MINUTE_MS) {
      const midpointMs = start.getTime() + (end.getTime() - start.getTime()) / 2;
      const earliest = overlapStart;
      const latest = overlapEnd - 30 * MINUTE_MS;
      const suggestedMs = clamp(roundDownQuarter(midpointMs - 15 * MINUTE_MS), earliest, latest);
      return {
        code: "noon-meal",
        slot: "primary",
        minimumMinutes: 30,
        label: "30-minute noon meal",
        detail: "A shift over six hours extending through New York's 11 AM–2 PM noon meal period requires at least 30 off-duty minutes inside that window.",
        suggestedStart: new Date(suggestedMs).toISOString(),
        windowStart: new Date(overlapStart).toISOString(),
        windowEnd: new Date(overlapEnd).toISOString(),
      };
    }
  }
  return null;
}

function extraEveningRequirement(start: Date, end: Date): MealRequirement | null {
  for (const key of dateKeysBetween(start, end)) {
    const beforeEleven = newYorkDateTime(key, "11:00");
    const afterSeven = newYorkDateTime(key, "19:00");
    if (start < beforeEleven && end > afterSeven) {
      const windowStart = newYorkDateTime(key, "17:00");
      const windowEnd = newYorkDateTime(key, "19:00");
      return {
        code: "extra-evening",
        slot: "extra",
        minimumMinutes: 20,
        label: "Additional 20-minute evening meal",
        detail: "A shift starting before 11 AM and continuing after 7 PM requires an additional 20 off-duty minutes between 5 PM and 7 PM.",
        suggestedStart: windowStart.toISOString(),
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      };
    }
  }
  return null;
}

export function mealRequirements(input: Pick<MealScheduleInput, "startsAt" | "endsAt" | "business" | "position">): MealRequirement[] {
  const business = String(input.business || "").trim();
  const position = String(input.position || "").trim().toLowerCase();
  // Tiki normally runs a single bartender, so an off-duty meal would leave the bar uncovered.
  // Do not impose Corner Deli's scheduled meal requirement on Tiki/Bartender shifts.
  if (business === "Tiki" || position === "bartender") return [];

  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return [];
  const grossMinutes = (end.getTime() - start.getTime()) / MINUTE_MS;
  const requirements: MealRequirement[] = [];

  if (grossMinutes > 360) {
    const startMinute = minutesOfDay(start);
    const lateShift = startMinute >= 13 * 60 || startMinute < 6 * 60;
    if (lateShift) {
      requirements.push(midpointRequirement("late-shift", start, end, 30));
    } else {
      requirements.push(noonRequirement(start, end) || midpointRequirement("general-six-hour", start, end, 30));
    }
  }

  const extra = extraEveningRequirement(start, end);
  if (extra) requirements.push(extra);
  return requirements;
}

function scheduledBreak(startValue: string | null | undefined, minutesValue: number | null | undefined) {
  const minutes = Math.max(0, Math.round(Number(minutesValue || 0)));
  const start = startValue ? new Date(startValue) : null;
  if (!start || !Number.isFinite(start.getTime()) || !minutes) return null;
  return { start, end: new Date(start.getTime() + minutes * MINUTE_MS), minutes };
}

function fullyInside(start: Date, end: Date, outerStart: Date, outerEnd: Date): boolean {
  return start >= outerStart && end <= outerEnd;
}

export function analyzeShiftMealCompliance(input: MealScheduleInput) {
  const shiftStart = new Date(input.startsAt);
  const shiftEnd = new Date(input.endsAt);
  const requirements = mealRequirements(input);
  const primary = scheduledBreak(input.mealBreakStart, input.mealBreakMinutes);
  const extra = scheduledBreak(input.extraMealBreakStart, input.extraMealBreakMinutes);
  const issues: MealComplianceIssue[] = [];

  for (const requirement of requirements) {
    const planned = requirement.slot === "primary" ? primary : extra;
    if (!planned) {
      issues.push({
        code: `${requirement.code}-missing`,
        slot: requirement.slot,
        message: `${requirement.label} is required but has not been scheduled.`,
      });
      continue;
    }
    if (!fullyInside(planned.start, planned.end, shiftStart, shiftEnd)) {
      issues.push({
        code: `${requirement.code}-outside-shift`,
        slot: requirement.slot,
        message: `${requirement.label} must occur entirely inside the shift.`,
      });
    }
    if (planned.minutes < requirement.minimumMinutes) {
      issues.push({
        code: `${requirement.code}-short`,
        slot: requirement.slot,
        message: `${requirement.label} must be at least ${requirement.minimumMinutes} minutes.`,
      });
    }
    if (requirement.windowStart && requirement.windowEnd) {
      const windowStart = new Date(requirement.windowStart);
      const windowEnd = new Date(requirement.windowEnd);
      if (!fullyInside(planned.start, planned.end, windowStart, windowEnd)) {
        issues.push({
          code: `${requirement.code}-window`,
          slot: requirement.slot,
          message: `${requirement.label} must be scheduled within ${new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(windowStart)}–${new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(windowEnd)}.`,
        });
      }
    }
    if (requirement.midpoint) {
      const midpoint = new Date(requirement.midpoint);
      if (!(planned.start <= midpoint && planned.end >= midpoint)) {
        issues.push({
          code: `${requirement.code}-midpoint`,
          slot: requirement.slot,
          message: `${requirement.label} must cover the midpoint of the shift.`,
        });
      }
    }
  }

  if (primary && extra && primary.start < extra.end && extra.start < primary.end) {
    issues.push({
      code: "meal-breaks-overlap",
      slot: "extra",
      message: "The additional evening meal must be separate from the primary meal period.",
    });
  }

  for (const [slot, planned] of [["primary", primary], ["extra", extra]] as const) {
    if (planned && !fullyInside(planned.start, planned.end, shiftStart, shiftEnd)) {
      if (!issues.some((issue) => issue.slot === slot && issue.code.endsWith("outside-shift"))) {
        issues.push({
          code: `${slot}-break-outside-shift`,
          slot,
          message: `${slot === "primary" ? "Meal" : "Additional meal"} period must occur entirely inside the shift.`,
        });
      }
    }
    if (planned && minutesOfDay(planned.start) % 15 !== 0) {
      issues.push({
        code: `${slot}-break-quarter-hour`,
        slot,
        message: `${slot === "primary" ? "Meal" : "Additional meal"} start must use a 15-minute interval.`,
      });
    }
  }

  const validBreaks = [primary, extra].filter((planned) => planned && fullyInside(planned.start, planned.end, shiftStart, shiftEnd));
  const unpaidBreakMinutes = validBreaks.reduce((total, planned) => total + (planned?.minutes || 0), 0);
  const grossHours = Math.max(0, (shiftEnd.getTime() - shiftStart.getTime()) / 3_600_000);
  const paidHours = Math.max(0, grossHours - unpaidBreakMinutes / 60);

  return {
    requirements,
    issues,
    compliant: issues.length === 0,
    grossHours,
    paidHours,
    unpaidBreakMinutes,
    primaryBreak: primary,
    extraBreak: extra,
  };
}

export function shiftTimeForSelectedDay(dateKey: string, shiftStartTime: string, selectedTime: string): Date {
  const shiftStart = newYorkDateTime(dateKey, shiftStartTime);
  let selected = newYorkDateTime(dateKey, selectedTime);
  if (selected < shiftStart) selected = newYorkDateTime(dateKeyPlus(dateKey, 1), selectedTime);
  return selected;
}
