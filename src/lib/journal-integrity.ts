export type JournalAmountLine = { debit: number; credit: number };

function cents(value: number): number {
  return Math.round(Number(value || 0) * 100);
}

export function journalDifference(lines: JournalAmountLine[]): number {
  const debitCents = lines.reduce((sum, line) => sum + cents(line.debit), 0);
  const creditCents = lines.reduce((sum, line) => sum + cents(line.credit), 0);
  return (debitCents - creditCents) / 100;
}

export function assertBalancedJournalLines(lines: JournalAmountLine[]): void {
  const difference = journalDifference(lines);
  if (Math.abs(difference) > 0.005) throw new Error(`Journal entry is out of balance by ${difference.toFixed(2)}.`);
}
