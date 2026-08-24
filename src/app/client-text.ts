export function firstName(value: string | null | undefined, fallback = "Unknown"): string {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const candidate = text.includes("@")
    ? text.split("@")[0].split(/[._-]/)[0]
    : text.split(/\s+/)[0];
  return candidate ? candidate.charAt(0).toUpperCase() + candidate.slice(1) : fallback;
}
