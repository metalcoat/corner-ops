import { getSql } from "@/lib/db";
import { threeCxDeliCallReport } from "@/lib/three-cx-calls-report";
import { correctThreeCxCallReport } from "@/lib/three-cx-time-correction";
import { ensureWorkforceSchema } from "@/lib/workforce";

const TIME_ZONE = "America/New_York";
let schemaPromise: Promise<void> | null = null;

type ClockedInEmployee = {
  id: string;
  name: string;
};

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPhone(value: string): string {
  const digits = String(value || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return value || "unknown caller";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

async function ensureNotificationSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureWorkforceSchema();
      await getSql()`
        CREATE TABLE IF NOT EXISTS three_cx_missed_call_notifications (
          id UUID PRIMARY KEY,
          history_id TEXT NOT NULL UNIQUE,
          dropped_at TIMESTAMPTZ NOT NULL,
          caller TEXT NOT NULL DEFAULT '',
          wait_seconds INTEGER NOT NULL DEFAULT 0,
          recipient_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function currentlyClockedInDeliEmployees(): Promise<ClockedInEmployee[]> {
  const rows = await getSql()`
    WITH latest_rezku_shift AS (
      SELECT DISTINCT ON (LOWER(BTRIM(employee_name)))
        employee_name, clock_in, clock_out
      FROM rezku_shifts
      WHERE clock_in IS NOT NULL
      ORDER BY LOWER(BTRIM(employee_name)), clock_in DESC
    )
    SELECT e.id, e.name
    FROM employees e
    JOIN latest_rezku_shift r
      ON LOWER(BTRIM(r.employee_name)) = LOWER(BTRIM(e.name))
    WHERE e.business = 'Corner Deli'
      AND e.active = TRUE
      AND r.clock_in <= NOW()
      AND (r.clock_out IS NULL OR r.clock_out > NOW())
      AND r.clock_in >= NOW() - INTERVAL '18 hours'
    ORDER BY e.name
  ` as unknown as ClockedInEmployee[];
  return rows;
}

export async function notifyClockedInDeliEmployeesOfMissedCalls() {
  await ensureNotificationSchema();
  const now = new Date();
  const report = correctThreeCxCallReport(await threeCxDeliCallReport(
    localDateKey(addDays(now, -1)),
    localDateKey(addDays(now, 2)),
  ));
  const recentCutoff = now.getTime() - 45 * 60_000;
  const futureTolerance = now.getTime() + 5 * 60_000;
  const recentCalls = report.calls.filter((call) => {
    const dropped = new Date(call.droppedAt).getTime();
    return Number.isFinite(dropped) && dropped >= recentCutoff && dropped <= futureTolerance;
  });

  let newMissedCalls = 0;
  let messagesCreated = 0;
  const recipients = new Set<string>();

  for (const call of recentCalls) {
    const marker = await getSql()`
      INSERT INTO three_cx_missed_call_notifications (
        id, history_id, dropped_at, caller, wait_seconds
      ) VALUES (
        ${crypto.randomUUID()}, ${call.historyId}, ${call.droppedAt}, ${call.caller}, ${call.waitSeconds}
      )
      ON CONFLICT (history_id) DO NOTHING
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    if (!marker[0]) continue;

    newMissedCalls += 1;
    const clockedIn = await currentlyClockedInDeliEmployees();
    const message = [
      `Missed call recorded at ${localTime(call.droppedAt)} from ${formatPhone(call.caller)} after ${call.waitSeconds} seconds.`,
      "Corner Ops is tracking missed calls while you are clocked in.",
      "Please answer incoming calls promptly and return this call if it still needs follow-up.",
    ].join(" ");

    for (const employee of clockedIn) {
      await getSql()`
        INSERT INTO employee_messages (
          id, business, sender_name, recipient_employee_id, message_type, body
        ) VALUES (
          ${crypto.randomUUID()}, 'Corner Deli', 'Corner Ops Call Monitor',
          ${employee.id}, 'Announcement', ${message}
        )
      `;
      recipients.add(employee.id);
      messagesCreated += 1;
    }

    await getSql()`
      UPDATE three_cx_missed_call_notifications
      SET recipient_count = ${clockedIn.length}
      WHERE history_id = ${call.historyId}
    `;
  }

  return {
    callsChecked: recentCalls.length,
    newMissedCalls,
    messagesCreated,
    recipientCount: recipients.size,
    business: "Corner Deli" as const,
  };
}
