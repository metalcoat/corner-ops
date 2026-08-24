import { newYorkDateKey, newYorkDateTime, newYorkTimeValue } from "@/lib/schedule-meal-compliance";

function dateValue(value: unknown, label: string): Date {
  const result = new Date(String(value || ""));
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid.`);
  return result;
}

function addDateKeyDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function normalizeScheduleTimeRange(startsAt: unknown, endsAt: unknown) {
  const start = dateValue(startsAt, "Shift start");
  let end = dateValue(endsAt, "Shift end");

  if (end <= start) {
    end = newYorkDateTime(
      addDateKeyDays(newYorkDateKey(start), 1),
      newYorkTimeValue(end),
    );
  }

  if (end <= start) throw new Error("Shift end must be after the start.");
  const localStartKey = newYorkDateKey(start);
  const maximumEnd = newYorkDateTime(addDateKeyDays(localStartKey, 1), newYorkTimeValue(start));
  if (end > maximumEnd) throw new Error("A scheduled shift cannot exceed 24 wall-clock hours.");

  return { start, end };
}
