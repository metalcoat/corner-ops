export type PunchCommand = {
  requestId: string;
  action: "clock-in" | "clock-out";
  entryId: string | null;
};
export type PunchReceipt = {
  requestId: string;
  action: "clocked-in" | "clocked-out";
  employee: string;
  entry: { id: string; clock_in: string; clock_out: string | null; status: string };
  replayed: boolean;
  locationReview: string | null;
  duplicateOpenPunchesClosed: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePunchCommand(value: unknown): PunchCommand | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.requestId !== "string" || !uuid.test(input.requestId)) return null;
  if (input.action !== "clock-in" && input.action !== "clock-out") return null;
  if (input.entryId !== null && (typeof input.entryId !== "string" || !uuid.test(input.entryId))) return null;
  if (input.action === "clock-out" && input.entryId === null) return null;
  return { requestId: input.requestId.toLowerCase(), action: input.action, entryId: typeof input.entryId === "string" ? input.entryId.toLowerCase() : null };
}

export function isPunchReceipt(value: unknown, command: PunchCommand): value is PunchReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PunchReceipt>;
  const expected = command.action === "clock-in" ? "clocked-in" : "clocked-out";
  return row.requestId === command.requestId && row.action === expected
    && typeof row.employee === "string" && row.employee.trim().length > 0
    && typeof row.entry?.id === "string" && uuid.test(row.entry.id)
    && (command.action !== "clock-out" || row.entry.id === command.entryId)
    && typeof row.entry.clock_in === "string" && Number.isFinite(Date.parse(row.entry.clock_in))
    && (command.action === "clock-in" ? row.entry.clock_out === null
      : typeof row.entry.clock_out === "string" && Number.isFinite(Date.parse(row.entry.clock_out)));
}
