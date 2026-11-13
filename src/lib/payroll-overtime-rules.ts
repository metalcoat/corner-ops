/**
 * Second overtime rule (Chris, 2026-11-07): weekly overtime is every hour past 40 across all roles,
 * taken in the order the hours were worked. Each overtime hour belongs to the role being worked at that
 * moment: driving (tipped) overtime is paid at the tipped overtime rate, in-store at 1.5 × regular.
 */
export type WorkSegment = { start: Date; hours: number; tipped: boolean };

export type OvertimeSplit = {
  regularStraightHours: number;
  tippedStraightHours: number;
  regularOvertimeHours: number;
  tippedOvertimeHours: number;
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function splitOvertimeByRole(segments: WorkSegment[], thresholdHours = 40): OvertimeSplit {
  const split = { regularStraightHours: 0, tippedStraightHours: 0, regularOvertimeHours: 0, tippedOvertimeHours: 0 };
  let worked = 0;
  for (const segment of [...segments].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const hours = Math.max(0, segment.hours);
    const straight = Math.max(0, Math.min(hours, thresholdHours - worked));
    const overtime = hours - straight;
    worked += hours;
    if (segment.tipped) { split.tippedStraightHours += straight; split.tippedOvertimeHours += overtime; }
    else { split.regularStraightHours += straight; split.regularOvertimeHours += overtime; }
  }
  return {
    regularStraightHours: round2(split.regularStraightHours),
    tippedStraightHours: round2(split.tippedStraightHours),
    regularOvertimeHours: round2(split.regularOvertimeHours),
    tippedOvertimeHours: round2(split.tippedOvertimeHours),
  };
}

/** Overtime pay per role, in cents. */
export function overtimePayCents(split: OvertimeSplit, rates: { regularRateCents: number; tippedOvertimeRateCents: number }) {
  const regular = Math.round(split.regularOvertimeHours * Math.round(1.5 * rates.regularRateCents));
  const tipped = Math.round(split.tippedOvertimeHours * rates.tippedOvertimeRateCents);
  return { regularCents: regular, tippedCents: tipped, totalCents: regular + tipped };
}

/**
 * Default overtime for two rates when there is no signed by-role agreement (29 CFR 778.115): every hour
 * is paid straight time at its own role's cash rate, plus a half-time premium on the weighted-average
 * regular rate for each overtime hour. Tipped hours count at the full rate (cash wage + tip credit).
 * Returns the overtime hours' cash pay, comparable to overtimePayCents().totalCents.
 */
export function weightedAverageOvertimeCents(split: OvertimeSplit, rates: { regularRateCents: number; tippedCashRateCents: number; tippedFullRateCents: number }): number {
  const regularHours = split.regularStraightHours + split.regularOvertimeHours;
  const tippedHours = split.tippedStraightHours + split.tippedOvertimeHours;
  const totalHours = regularHours + tippedHours;
  const overtimeHours = split.regularOvertimeHours + split.tippedOvertimeHours;
  if (!totalHours || !overtimeHours) return 0;
  const regularRate = (regularHours * rates.regularRateCents + tippedHours * rates.tippedFullRateCents) / totalHours;
  return Math.round(split.regularOvertimeHours * rates.regularRateCents + split.tippedOvertimeHours * rates.tippedCashRateCents + 0.5 * regularRate * overtimeHours);
}
