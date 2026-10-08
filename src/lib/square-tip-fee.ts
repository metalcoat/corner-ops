const MAX_TIP_FEE_RATE = 0.035;

export type SquareTipAllocation = {
  grossCents: number;
  feeCents: number;
  netCents: number;
};

// Square charges the whole payment. Only the tip's proportional share of its
// recorded fee can be withheld, and this business caps that share at 3.5%.
export function allocateSquareTipAfterFee(
  tipCents: number,
  employeeCount: number,
  paymentCents: number,
  processingFeeCents: number | null,
): SquareTipAllocation[] {
  if (!Number.isSafeInteger(tipCents) || tipCents <= 0 || !Number.isSafeInteger(employeeCount) || employeeCount <= 0) return [];

  const grossBase = Math.floor(tipCents / employeeCount);
  const grossRemainder = tipCents % employeeCount;
  const gross = Array.from({ length: employeeCount }, (_, index) => grossBase + (index < grossRemainder ? 1 : 0));
  const feeAvailable = processingFeeCents !== null && Number.isSafeInteger(processingFeeCents)
    && processingFeeCents >= 0 && Number.isSafeInteger(paymentCents) && paymentCents >= tipCents;
  const actualTipFeeCents = feeAvailable
    ? Math.round(processingFeeCents * tipCents / paymentCents)
    : 0;
  const feeCents = Math.min(Math.round(tipCents * MAX_TIP_FEE_RATE), actualTipFeeCents);
  const targetNetCents = tipCents - feeCents;

  const net = gross.map((amount) => Math.floor(amount * targetNetCents / tipCents));
  const fractions = gross.map((amount, index) => ({
    index,
    remainder: amount * targetNetCents / tipCents - net[index],
  })).sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  let remainder = targetNetCents - net.reduce((sum, amount) => sum + amount, 0);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) net[fractions[index].index] += 1;

  return gross.map((grossCents, index) => ({
    grossCents,
    feeCents: grossCents - net[index],
    netCents: net[index],
  }));
}
