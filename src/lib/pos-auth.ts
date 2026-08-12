import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { ensureSchema, getSql, withTransaction } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { validateEmployeePin } from "@/lib/employee-pin";

export const POS_COOKIE = "corner_ops_pos";
export const POS_SESSION_SECONDS = 60 * 60 * 12;

export type PosSession = {
  employeeId: string;
  business: "Corner Deli";
  name: string;
  position: string;
  issuedAt: number;
  expiresAt: number;
  clockInRequired: boolean;
};

type EmployeeRow = { id: string; business: "Corner Deli"; name: string; position: string };

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required.");
  return value;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function hashEmployeePin(business: "Corner Deli", pin: string): string {
  return createHmac("sha256", secret()).update(`${business}:${pin}`).digest("hex");
}

export function encodePosSession(payload: PosSession): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodePosSession(token: string): PosSession | null {
  const [body, supplied] = token.split(".");
  if (!body || !supplied || !equal(sign(body), supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PosSession;
    if (!payload.employeeId || !payload.name || payload.business !== "Corner Deli" || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function ensurePosAuthSchema(): Promise<void> {
  await ensureSchema();
  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS pos_pin_attempts (
      attempt_key TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function enforceAttemptLimit(key: string): Promise<void> {
  const rows = await getSql()`SELECT failed_count, window_started_at, locked_until FROM pos_pin_attempts WHERE attempt_key = ${key}`;
  const row = rows[0];
  if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    throw new Error("Too many attempts. Wait one minute and try again.");
  }
}

async function recordFailedAttempt(key: string): Promise<void> {
  await getSql()`
    INSERT INTO pos_pin_attempts (attempt_key, failed_count, window_started_at, locked_until, updated_at)
    VALUES (${key}, 1, NOW(), NULL, NOW())
    ON CONFLICT (attempt_key) DO UPDATE SET
      failed_count = CASE WHEN pos_pin_attempts.window_started_at < NOW() - INTERVAL '10 minutes' THEN 1 ELSE pos_pin_attempts.failed_count + 1 END,
      window_started_at = CASE WHEN pos_pin_attempts.window_started_at < NOW() - INTERVAL '10 minutes' THEN NOW() ELSE pos_pin_attempts.window_started_at END,
      locked_until = CASE WHEN (CASE WHEN pos_pin_attempts.window_started_at < NOW() - INTERVAL '10 minutes' THEN 1 ELSE pos_pin_attempts.failed_count + 1 END) >= 8 THEN NOW() + INTERVAL '1 minute' ELSE NULL END,
      updated_at = NOW()
  `;
}

export async function authenticateDeliPosPin(suppliedPin: unknown, attemptKey: string): Promise<PosSession> {
  await ensurePosAuthSchema();
  const key = String(attemptKey || "unknown").slice(0, 160);
  await enforceAttemptLimit(key);
  let pin: string;
  try {
    pin = validateEmployeePin("Corner Deli", suppliedPin, "Corner Deli");
  } catch (error) {
    await recordFailedAttempt(key);
    throw error;
  }
  const rows = await getSql()`
    SELECT id, business, name, position
    FROM employees
    WHERE business = 'Corner Deli' AND pin_hash = ${hashEmployeePin("Corner Deli", pin)}
      AND pin_enabled = TRUE AND active = TRUE
  ` as EmployeeRow[];
  if (rows.length !== 1) {
    await recordFailedAttempt(key);
    throw new Error("PIN not recognized for this location.");
  }
  await getSql()`DELETE FROM pos_pin_attempts WHERE attempt_key = ${key}`;
  const open = await getSql()`SELECT id FROM time_entries WHERE employee_id = ${rows[0].id} AND business = 'Corner Deli' AND clock_out IS NULL LIMIT 1`;
  const issuedAt = Date.now();
  return {
    employeeId: rows[0].id,
    business: "Corner Deli",
    name: rows[0].name,
    position: rows[0].position,
    issuedAt,
    expiresAt: issuedAt + POS_SESSION_SECONDS * 1000,
    clockInRequired: !open[0],
  };
}

export async function clockInDeliPosEmployee(session: PosSession) {
  if (session.business !== "Corner Deli") throw new Error("Corner Deli employee session required.");
  return withTransaction(async () => {
    const sql = getSql();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${session.employeeId}))`;
    const employeeRows = await sql`
      SELECT id, name, position, role_group FROM employees
      WHERE id = ${session.employeeId} AND business = 'Corner Deli' AND active = TRUE LIMIT 1
    `;
    const employee = employeeRows[0];
    if (!employee) throw new Error("Employee is no longer active at Corner Deli.");
    const existing = await sql`
      SELECT id, clock_in FROM time_entries
      WHERE employee_id = ${session.employeeId} AND business = 'Corner Deli' AND clock_out IS NULL LIMIT 1
    `;
    if (existing[0]) return { entry: existing[0], alreadyClockedIn: true };
    const rows = await sql`
      INSERT INTO time_entries (
        id, business, employee_id, employee_name, position, role_group,
        clock_in, source, status, notes
      ) VALUES (
        ${randomUUID()}, 'Corner Deli', ${session.employeeId}, ${employee.name}, ${employee.position},
        ${employee.role_group}, NOW(), 'Corner Deli POS', 'Open', 'Explicit POS clock-in'
      )
      RETURNING id, clock_in
    `;
    return { entry: rows[0], alreadyClockedIn: false };
  });
}

export async function setPosSession(session: PosSession): Promise<void> {
  (await cookies()).set(POS_COOKIE, encodePosSession(session), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: POS_SESSION_SECONDS,
  });
}

export async function getPosSession(requireClockedIn = true): Promise<PosSession | null> {
  if (!process.env.SESSION_SECRET) return null;
  const raw = (await cookies()).get(POS_COOKIE)?.value;
  const session = raw ? decodePosSession(raw) : null;
  if (!session || (requireClockedIn && session.clockInRequired)) return null;
  return session;
}

export async function clearPosSession(): Promise<void> {
  (await cookies()).set(POS_COOKIE, "", {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 0,
  });
}
