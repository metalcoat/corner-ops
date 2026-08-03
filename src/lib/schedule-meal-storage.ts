import { getSql } from "@/lib/db";
import { newYorkTimeValue } from "@/lib/schedule-meal-compliance";
import { ensureWorkforceSchema } from "@/lib/workforce";

let mealSchemaPromise: Promise<void> | null = null;

export type ScheduledMealFields = {
  mealBreakStart: string | null;
  mealBreakMinutes: number;
  extraMealBreakStart: string | null;
  extraMealBreakMinutes: number;
};

export function ensureScheduleMealSchema(): Promise<void> {
  if (!mealSchemaPromise) {
    mealSchemaPromise = (async () => {
      await ensureWorkforceSchema();
      const sql = getSql();
      await sql`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS meal_break_start TIMESTAMPTZ`;
      await sql`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS meal_break_minutes INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS extra_meal_break_start TIMESTAMPTZ`;
      await sql`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS extra_meal_break_minutes INTEGER NOT NULL DEFAULT 0`;
    })().catch((error) => {
      mealSchemaPromise = null;
      throw error;
    });
  }
  return mealSchemaPromise;
}

function optionalDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid.`);
  return date;
}

function minutesValue(value: unknown, label: string): number {
  const minutes = Math.round(Number(value || 0));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
    throw new Error(`${label} must be between 0 and 240 minutes.`);
  }
  return minutes;
}

function validateOne(
  label: string,
  shiftStart: Date,
  shiftEnd: Date,
  breakStart: Date | null,
  minutes: number,
) {
  if ((breakStart && !minutes) || (!breakStart && minutes)) {
    throw new Error(`${label} needs both a start time and duration.`);
  }
  if (!breakStart) return;
  if (Number(newYorkTimeValue(breakStart).slice(3, 5)) % 15 !== 0) {
    throw new Error(`${label} must start on a 15-minute interval.`);
  }
  const breakEnd = new Date(breakStart.getTime() + minutes * 60_000);
  if (breakStart < shiftStart || breakEnd > shiftEnd) {
    throw new Error(`${label} must occur entirely inside the shift.`);
  }
}

export function normalizeScheduledMealFields(input: {
  startsAt: string | Date;
  endsAt: string | Date;
  mealBreakStart?: unknown;
  mealBreakMinutes?: unknown;
  extraMealBreakStart?: unknown;
  extraMealBreakMinutes?: unknown;
}): ScheduledMealFields {
  const shiftStart = input.startsAt instanceof Date ? input.startsAt : new Date(input.startsAt);
  const shiftEnd = input.endsAt instanceof Date ? input.endsAt : new Date(input.endsAt);
  if (Number.isNaN(shiftStart.getTime()) || Number.isNaN(shiftEnd.getTime()) || shiftEnd <= shiftStart) {
    throw new Error("Shift date or time is invalid.");
  }

  const mealBreakStart = optionalDate(input.mealBreakStart, "Meal break start");
  const mealBreakMinutes = minutesValue(input.mealBreakMinutes, "Meal break duration");
  const extraMealBreakStart = optionalDate(input.extraMealBreakStart, "Additional meal break start");
  const extraMealBreakMinutes = minutesValue(input.extraMealBreakMinutes, "Additional meal break duration");

  validateOne("Meal break", shiftStart, shiftEnd, mealBreakStart, mealBreakMinutes);
  validateOne("Additional meal break", shiftStart, shiftEnd, extraMealBreakStart, extraMealBreakMinutes);

  if (mealBreakStart && extraMealBreakStart) {
    const mealEnd = new Date(mealBreakStart.getTime() + mealBreakMinutes * 60_000);
    const extraEnd = new Date(extraMealBreakStart.getTime() + extraMealBreakMinutes * 60_000);
    if (mealBreakStart < extraEnd && extraMealBreakStart < mealEnd) {
      throw new Error("The primary and additional meal periods cannot overlap.");
    }
  }

  return {
    mealBreakStart: mealBreakStart?.toISOString() || null,
    mealBreakMinutes,
    extraMealBreakStart: extraMealBreakStart?.toISOString() || null,
    extraMealBreakMinutes,
  };
}
