/** Splits shared cents across checks, giving any remainder to the first ones. */
export function splitShared(cents: number, count: number) {
  const base = Math.trunc(cents / count);
  let remainder = cents - base * count;
  return Array.from({ length: count }, () => {
    const step = remainder > 0 ? 1 : remainder < 0 ? -1 : 0;
    remainder -= step;
    return base + step;
  });
}
