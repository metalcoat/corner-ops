/**
 * Scheduler hint for the second overtime rule: overtime hours are the ones past 40 in the order worked,
 * and driving overtime costs less than in-store overtime ($18.70 vs 1.5 × regular for a $10.70 driver).
 * So when someone is scheduled over 40, say which shifts the overtime lands on and suggest putting
 * their driving at the end of the week. A suggestion only; nothing is blocked.
 */
export type HintShift = { id: string; startsAt: string; endsAt: string; position?: string | null; hours: number };

export const isDrivingPosition = (position: string | null | undefined) => /\b(driver|delivery|deliveries|driving)\b/i.test(String(position || ""));

export function overtimeScheduleHint(shifts: HintShift[], thresholdHours = 40) {
  const ordered = [...shifts].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  let worked = 0;
  const overtimeShifts: Array<{ id: string; startsAt: string; position: string; overtimeHours: number; driving: boolean }> = [];
  for (const shift of ordered) {
    const before = worked;
    worked += shift.hours;
    const overtime = Math.max(0, worked - Math.max(thresholdHours, before));
    if (overtime > 0) overtimeShifts.push({ id: shift.id, startsAt: shift.startsAt, position: String(shift.position || ""), overtimeHours: Math.round(overtime * 100) / 100, driving: isDrivingPosition(shift.position) });
  }
  const inStoreOvertime = overtimeShifts.filter((shift) => !shift.driving).reduce((sum, shift) => sum + shift.overtimeHours, 0);
  const lastOvertimeStart = overtimeShifts[0] ? new Date(overtimeShifts[0].startsAt).getTime() : Infinity;
  const earlierDriving = ordered.filter((shift) => isDrivingPosition(shift.position) && new Date(shift.startsAt).getTime() < lastOvertimeStart);
  let suggestion = "";
  if (inStoreOvertime > 0 && earlierDriving.length) suggestion = "Swap so their driving shift is last in the week; the overtime then falls on driving (cheaper tipped overtime) instead of in-store.";
  else if (inStoreOvertime > 0) suggestion = "If they can drive, make their last shift of the week a Delivery shift so the overtime falls on driving (cheaper tipped overtime).";
  return { overtimeShifts, inStoreOvertimeHours: Math.round(inStoreOvertime * 100) / 100, suggestion };
}
