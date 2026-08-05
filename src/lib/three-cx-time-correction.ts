const DISPLAY_TIME_ZONE = "America/New_York";

function correctedDate(value: string | null): Date | null {
  if (!value) return null;
  const stored = new Date(value);
  if (Number.isNaN(stored.getTime())) return null;

  // 3CX CDR timestamps are UTC even when the value has no explicit offset.
  // Older Corner Ops ingestion treated those values as Eastern before storing
  // them as TIMESTAMPTZ. Reinterpret the stored Eastern wall-clock value as UTC.
  if (process.env.THREE_CX_DISABLE_UTC_TIME_FIX?.trim().toLowerCase() === "true") {
    return stored;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(stored);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  ));
}

export function correctThreeCxTimestamp(value: string | null): string | null {
  return correctedDate(value)?.toISOString() || null;
}

type CallWithTimes = {
  droppedAt: string;
  callbackAt: string | null;
};

export function correctThreeCxCallReport<T extends { calls: CallWithTimes[] }>(report: T): T {
  return {
    ...report,
    calls: report.calls.map((call) => ({
      ...call,
      droppedAt: correctThreeCxTimestamp(call.droppedAt) || call.droppedAt,
      callbackAt: correctThreeCxTimestamp(call.callbackAt),
    })),
  };
}
