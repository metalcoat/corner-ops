const employmentSensitiveKeys = new Set([
  "ssn",
  "socialsecuritynumber",
  "socialsecurity",
  "anumber",
  "alienregistrationnumber",
  "uscisnumber",
  "i94",
  "i94number",
  "i94admissionnumber",
  "passportnumber",
  "foreignpassportnumber",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function redactEmploymentSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEmploymentSensitiveData);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (employmentSensitiveKeys.has(normalizedKey(key))) continue;
    output[key] = redactEmploymentSensitiveData(child);
  }
  return output;
}

export function maskLastFour(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `••••${digits.slice(-4)}`;
}
