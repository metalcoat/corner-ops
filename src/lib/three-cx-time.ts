export function parseThreeCxTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value ?? "").trim();
  if (!text || /^0{4}[-/]0{2}[-/]0{2}/.test(text)) return null;

  const naive = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (naive) {
    return new Date(Date.UTC(
      Number(naive[1]),
      Number(naive[2]) - 1,
      Number(naive[3]),
      Number(naive[4]),
      Number(naive[5]),
      Number(naive[6] || 0),
    ));
  }

  const direct = new Date(text);
  return Number.isNaN(direct.getTime()) ? null : direct;
}
