function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => [key, canonical(row)]));
  return value;
}

export function sameCartConfiguration(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function consolidateQuantities<T extends { quantity: number }>(lines: T[], configuration: (line: T) => unknown) {
  const consolidated: T[] = [];
  for (const line of lines) {
    const index = consolidated.findIndex((candidate) => sameCartConfiguration(configuration(candidate), configuration(line)));
    if (index < 0) consolidated.push(line);
    else consolidated[index] = { ...consolidated[index], quantity: consolidated[index].quantity + line.quantity };
  }
  return consolidated;
}
