/**
 * New York minimum wage for food service workers (Hospitality Wage Order, Part 146), remainder of
 * state (outside NYC, Long Island, Westchester). Delivery drivers are food service workers, so the
 * tip credit applies to their tipped (driving) hours. Verified with NY DOL for 2026:
 * https://dol.ny.gov/minimum-wage-tipped-workers and https://forms.labor.ny.gov/WP/CR146.pdf
 * Add the next year's row when NY publishes it.
 */
export const NY_UPSTATE_FOOD_SERVICE: Record<number, { minimumCents: number; cashWageCents: number; tipCreditCents: number }> = {
  2026: { minimumCents: 1600, cashWageCents: 1070, tipCreditCents: 530 },
};

export function nyFoodServiceRates(year: number) {
  const known = Object.keys(NY_UPSTATE_FOOD_SERVICE).map(Number).filter((y) => y <= year).sort((a, b) => b - a)[0];
  return NY_UPSTATE_FOOD_SERVICE[known ?? 2026];
}

/** Problem with a driver (tipped) hourly rate, or "" when it is allowed. */
export function tippedRateProblem(input: { tippedRateCents: number; hourlyRateCents: number; year: number }): string {
  if (!input.tippedRateCents) return "";
  const rates = nyFoodServiceRates(input.year);
  if (input.tippedRateCents < rates.cashWageCents) return `The driver (tipped) rate can't be under $${(rates.cashWageCents / 100).toFixed(2)}, New York's ${input.year} food service cash wage.`;
  if (input.hourlyRateCents && input.tippedRateCents > input.hourlyRateCents) return "The driver (tipped) rate should not be higher than the regular rate.";
  return "";
}

/**
 * Weekly check for each driver: cash wage plus delivery tips for the tipped hours must reach the full
 * minimum wage for those hours. Anything short has to be paid on top (the tip credit can't be used).
 */
export function tipCreditShortfallCents(input: { tippedHours: number; tippedRateCents: number; tipsCents: number; year: number }): number {
  const hours = Math.max(0, input.tippedHours);
  if (!hours || !input.tippedRateCents) return 0;
  const owed = Math.round(hours * nyFoodServiceRates(input.year).minimumCents);
  const paid = Math.round(hours * input.tippedRateCents) + Math.max(0, Math.round(input.tipsCents));
  return Math.max(0, owed - paid);
}

/**
 * Overtime cash rate for tipped (driving) hours: 1.5 × the full rate (cash wage + tip credit) minus the tip
 * credit, i.e. driver rate + half the minimum while a credit is taken. 2026: $10.70 → $18.70 (1.5 × $16.00 − $5.30).
 * With no tip credit (driver rate at or above minimum) it is plain 1.5 × the driver rate.
 */
export function tippedOvertimeRateCents(tippedRateCents: number, year: number): number {
  const rates = nyFoodServiceRates(year);
  const credit = Math.max(0, Math.min(rates.tipCreditCents, rates.minimumCents - tippedRateCents));
  return Math.round(1.5 * (tippedRateCents + credit)) - credit;
}

/** Full hourly rate for a tipped hour (cash wage + the tip credit taken), used for the weighted-average regular rate. */
export function tippedFullRateCents(tippedRateCents: number, year: number): number {
  const rates = nyFoodServiceRates(year);
  return tippedRateCents + Math.max(0, Math.min(rates.tipCreditCents, rates.minimumCents - tippedRateCents));
}
