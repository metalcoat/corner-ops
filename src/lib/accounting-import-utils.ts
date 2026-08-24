export function parseAccountingMoney(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  const source = String(value ?? "").trim();
  if (!source) return 0;
  const negative = /^\s*\(/.test(source)
    || /^\s*-/.test(source)
    || /-\s*$/.test(source)
    || /\bDR\b/i.test(source);
  const numeric = Number(source
    .replace(/\b(?:CR|DR)\b/gi, "")
    .replace(/[,$()%\s]/g, "")
    .replace(/-+$/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((negative ? -Math.abs(numeric) : numeric) * 100) / 100;
}

export function codedHistoryBaseKey(input: {
  externalItemId: string;
  date: string;
  description: string;
  signedAmount: number;
  accountCode: string;
}): string {
  return [
    input.externalItemId,
    input.date,
    input.description.trim().toLowerCase().replace(/\s+/g, " "),
    input.signedAmount.toFixed(2),
    input.accountCode,
  ].join("|");
}

export function nextOccurrence(occurrence: Map<string, number>, key: string): number {
  const ordinal = (occurrence.get(key) || 0) + 1;
  occurrence.set(key, ordinal);
  return ordinal;
}
