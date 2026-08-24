export type SquareMoneyLike = { amount?: number | string } | null | undefined;

export function squareMoneyToDollars(value: SquareMoneyLike): number {
  const parsed = Number(String(value?.amount ?? "").replace(/[$,%\s,]/g, ""));
  return Math.round((Number.isFinite(parsed) ? parsed : 0)) / 100;
}
