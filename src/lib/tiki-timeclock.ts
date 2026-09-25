import { getSql } from "@/lib/db";
import { isPunchReceipt, type PunchCommand, type PunchReceipt } from "./timeclock-contract";
import { locationReview, type LocationInput } from "./timeclock-location";

export class TikiPunchStateError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export class TikiPunchUnconfirmedError extends Error {
  readonly code = "PUNCH_NOT_CONFIRMED";
  constructor() { super("The punch could not be confirmed. Retry the same request or ask a manager to verify it."); }
}

export async function getTikiClockState(employeeId: string) {
  const rows = await getSql()`
    SELECT id, clock_in, clock_out FROM time_entries
    WHERE employee_id = ${employeeId}::uuid AND business = 'Tiki'
    ORDER BY (clock_out IS NULL) DESC, clock_in DESC, created_at DESC, id DESC LIMIT 1
  ` as unknown as Array<{ id: string; clock_in: string; clock_out: string | null }>;
  return { entryId: rows[0]?.id || null, clockedIn: Boolean(rows[0] && rows[0].clock_out === null) };
}

export async function punchAuthenticatedTikiEmployee(
  employeeId: string, location: LocationInput, command: PunchCommand,
): Promise<PunchReceipt> {
  const check = locationReview(location);
  let value: unknown;
  try {
    const rows = await getSql()`
      SELECT public.corner_ops_punch_tiki(
        ${employeeId}::uuid, ${command.requestId}::uuid, ${command.action}::text, ${command.entryId}::uuid,
        ${check.latitude}::numeric, ${check.longitude}::numeric, ${check.accuracy}::numeric, ${check.reason}::text
      ) AS receipt
    ` as unknown as Array<{ receipt: unknown }>;
    value = rows[0]?.receipt;
  } catch (error) {
    // A connection can fail after COMMIT. Never claim the employee is still in.
    console.error("[timeclock] punch confirmation failed", { requestId: command.requestId,
      code: (error as { code?: string })?.code || "UNKNOWN" });
    throw new TikiPunchUnconfirmedError();
  }
  if (value && typeof value === "object" && "code" in value) {
    const failure = value as { code: string; error?: string };
    throw new TikiPunchStateError(failure.code, failure.error || "Refresh your clock status before continuing.");
  }
  if (!isPunchReceipt(value, command)) throw new TikiPunchUnconfirmedError();
  return value;
}
