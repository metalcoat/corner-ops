import { createHash } from "node:crypto";

type ShiftLike = {
  id: string;
  employee_id?: string | null;
  employeeId?: string | null;
  position: string;
  starts_at?: string | Date;
  startsAt?: string | Date;
  ends_at?: string | Date;
  endsAt?: string | Date;
  meal_break_start?: string | Date | null;
  mealBreakStart?: string | Date | null;
  meal_break_minutes?: number;
  mealBreakMinutes?: number;
  extra_meal_break_start?: string | Date | null;
  extraMealBreakStart?: string | Date | null;
  extra_meal_break_minutes?: number;
  extraMealBreakMinutes?: number;
  notes?: string;
};

function timestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function scheduleStateHash(shifts: ShiftLike[]): string {
  const normalized = shifts.map((shift) => ({
    id: shift.id,
    employeeId: shift.employee_id ?? shift.employeeId ?? null,
    position: String(shift.position || "").trim(),
    startsAt: timestamp(shift.starts_at ?? shift.startsAt),
    endsAt: timestamp(shift.ends_at ?? shift.endsAt),
    mealBreakStart: timestamp(shift.meal_break_start ?? shift.mealBreakStart),
    mealBreakMinutes: Number(shift.meal_break_minutes ?? shift.mealBreakMinutes ?? 0),
    extraMealBreakStart: timestamp(shift.extra_meal_break_start ?? shift.extraMealBreakStart),
    extraMealBreakMinutes: Number(shift.extra_meal_break_minutes ?? shift.extraMealBreakMinutes ?? 0),
    notes: String(shift.notes || "").trim(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function schedulePublicationIdempotencyKey(input: {
  business: string;
  weekStart: string;
  previousPublicationId?: string | null;
  stateHash: string;
  mode: "initial" | "changes" | "resend";
}): string {
  return createHash("sha256").update([
    input.business,
    input.weekStart,
    input.previousPublicationId || "initial",
    input.stateHash,
    input.mode,
  ].join("|" )).digest("hex");
}
