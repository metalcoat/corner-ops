type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function unwrapHelcimPayResponse(eventMessage: unknown) {
  const parsed =
    typeof eventMessage === "string" ? JSON.parse(eventMessage) : eventMessage;
  const outer = record(parsed);
  if (!outer) throw new Error("Secure payment returned an invalid response.");
  const outerData = record(outer.data);
  const response =
    outerData && record(outerData.data) && typeof outerData.hash === "string"
      ? outerData
      : outer;
  const data = record(response.data);
  const hash = typeof response.hash === "string" ? response.hash : "";
  if (!data || !hash)
    throw new Error("Secure payment returned an incomplete approval response.");
  return { data, hash };
}
