const TIME_ZONE = "America/New_York";
const MINUTE_MS = 60_000;

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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function midpointRequirement(
  code: "general-six-hour" | "late-shift",
  start: Date,
  end: Date,
  minimumMinutes: number,
): MealRequirement {
  const midpointMs = start.getTime() + (end.getTime() - start.getTime()) / 2;
  const suggestedMs = roundDownQuarter(midpointMs - minimumMinutes * MINUTE_MS / 2);
  return {
    code,
    slot: "primary",
    minimumMinutes,
    label: code === "late-shift" ? "45-minute late-shift meal" : "30-minute meal",
    detail: code === "late-shift"
      ? "A shift over six hours starting between 1 PM and 6 AM requires at least 45 off-duty minutes around the middle of the shift."
      : "Company compliance policy requires at least 30 off-duty minutes around the middle of every shift over six hours.",
    suggestedStart: new Date(suggestedMs).toISOString(),
    midpoint: new Date(midpointMs).toISOString(),
  };
}

function noonRequirement(start: Date, end: Date): MealRequirement | null {
  if (end.getTime() - start.getTime() <= 360 * MINUTE_MS) return null;
  for (const key of dateKeysBetween(start, end)) {
    const windowStart = newYorkDateTime(key, "11:00");
    const windowEnd = newYorkDateTime(key, "14:00");
    if (start < windowStart && end > windowEnd) {
      const midpointMs = start.getTime() + (end.getTime() - start.getTime()) / 2;
      const earliest = windowStart.getTime();
      const latest = windowEnd.getTime() - 30 * MINUTE_MS;
      const suggestedMs = clamp(roundDownQuarter(midpointMs - 15 * MINUTE_MS), earliest, latest);
      return {
        code: "noon-meal",
        slot: "primary",
        minimumMinutes: 30,
        label: "30-minute noon meal",
        detail: "A shift over six hours extending through New York's 11 AM–2 PM noon meal period requires at least 30 off-duty minutes inside that window.",
        suggestedStart: new Date(suggestedMs).toISOString(),
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
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

export function mealRequirements(input: Pick<MealScheduleInput, "startsAt" | "endsAt">): MealRequirement[] {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return [];
  const grossMinutes = (end.getTime() - start.getTime()) / MINUTE_MS;
  const requirements: MealRequirement[] = [];

  if (grossMinutes > 360) {
    const startMinute = minutesOfDay(start);
    const lateShift = startMinute >= 13 * 60 || startMinute < 6 * 60;
    if (lateShift) {
      requirements.push(midpointRequirement("late-shift", start, end, 45));
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
