const DAY_MS = 24 * 60 * 60 * 1000;

function dateValue(value: unknown, label: string): Date {
  const result = new Date(String(value || ""));
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid.`);
  return result;
}

export function normalizeScheduleTimeRange(startsAt: unknown, endsAt: unknown) {
  const start = dateValue(startsAt, "Shift start");
  let end = dateValue(endsAt, "Shift end");

  // Scheduling forms commonly submit an overnight end time against the selected
  // start date. Treat an end at or before the start as the following calendar day.
  if (end <= start) end = new Date(end.getTime() + DAY_MS);

  if (end <= start) throw new Error("Shift end must be after the start.");
  if (end.getTime() - start.getTime() > DAY_MS) {
    throw new Error("A scheduled shift cannot exceed 24 hours.");
  }

  return { start, end };
}
