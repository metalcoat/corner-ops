import { randomUUID } from "node:crypto";
import { employeeByPin } from "@/lib/employee-pin-security";
import { cookies } from "next/headers";
import { ensureSchema, getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { AuthenticationError } from "@/lib/http";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";
import type { Business } from "@/lib/types";
import { secureCookies } from "@/lib/cookie-security";

const EMPLOYEE_COOKIE = "corner_ops_employee";
const EMPLOYEE_SESSION_SECONDS = 60 * 60 * 24 * 14;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EmployeeSession = {
  employeeId: string;
  business: Business;
  name: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  posRole: "employee" | "manager" | "owner";
  deviceSessionId: string;
  /** Bumped on the employee row to revoke every signed-in device. */
  sessionVersion?: number;
  expiresAt: number;
};

/** Purpose-specific key; cookies signed with the old shared SESSION_SECRET still verify. */
function sign(value: string): string {
  return hmacSignature(value, "employee-session", { envName: "EMPLOYEE_SESSION_SECRET" });
}

function encode(payload: EmployeeSession): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): EmployeeSession | null {
  const [body, supplied] = token.split(".");
  if (!body || !supplied) return null;
  let valid = false;
  try {
    valid = constantTimeEqual(sign(body), supplied) || constantTimeEqual(legacySessionHmac(body), supplied);
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EmployeeSession;
    if (!payload.employeeId || !payload.name || !payload.business || payload.expiresAt <= Date.now()) return null;
    // Sessions issued before device tracking have no device id; sign in again.
    if (!UUID_PATTERN.test(String(payload.deviceSessionId || ""))) return null;
    return { ...payload, sessionVersion: Number(payload.sessionVersion || 1) };
  } catch {
    return null;
  }
}

export async function createEmployeeSession(business: Business, suppliedPin: string, device: { label?: string; userAgent?: string } = {}): Promise<EmployeeSession> {
  await ensureSchema();
  await ensureEmployeeDirectorySchema();
  await getSql()`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pos_role TEXT NOT NULL DEFAULT 'employee'`;
  const employee = await employeeByPin(business, suppliedPin);
  if (!employee) throw new AuthenticationError("PIN not recognized for this location.");
  const payload: EmployeeSession = {
    employeeId: employee.id,
    business: employee.business,
    name: employee.name,
    position: employee.position,
    roleGroup: employee.role_group as EmployeeSession["roleGroup"],
    posRole: employee.pos_role as EmployeeSession["posRole"],
    deviceSessionId: randomUUID(),
    sessionVersion: Number(employee.session_version || 1),
    expiresAt: Date.now() + EMPLOYEE_SESSION_SECONDS * 1000,
  };
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, encode(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: EMPLOYEE_SESSION_SECONDS,
  });
  await getSql()`
    CREATE TABLE IF NOT EXISTS employee_app_sessions (
      id UUID PRIMARY KEY, employee_id UUID NOT NULL REFERENCES employees(id), business TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
      authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ
    )`;
  await getSql()`INSERT INTO employee_app_sessions(id,employee_id,business,device_label,user_agent,expires_at) VALUES(${payload.deviceSessionId},${payload.employeeId},${payload.business},${String(device.label||"").slice(0,120)},${String(device.userAgent||"").slice(0,500)},${new Date(payload.expiresAt)})`;
  return payload;
}

export async function getEmployeeSession(): Promise<EmployeeSession | null> {
  if (!process.env.EMPLOYEE_SESSION_SECRET && !process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(EMPLOYEE_COOKIE)?.value;
  const parsed = token ? decode(token) : null;
  if (!parsed) return null;
  // Deactivation, PIN disable, or a session_version bump revokes the cookie.
  const rows = await getSql()`
    SELECT id, business, name, position, session_version, active, pin_enabled,
      COALESCE(role_group, '') role_group,
      COALESCE(to_jsonb(employees) ->> 'pos_role', 'employee') pos_role
    FROM employees WHERE id = ${parsed.employeeId} AND business = ${parsed.business} LIMIT 1
  ` as unknown as Array<{
    id: string; business: Business; name: string; position: string; session_version: number;
    active: boolean; pin_enabled: boolean; role_group: string; pos_role: string;
  }>;
  const employee = rows[0];
  if (!employee?.active || !employee.pin_enabled || Number(employee.session_version || 1) !== Number(parsed.sessionVersion || 1)) return null;
  return {
    ...parsed,
    name: employee.name,
    position: employee.position,
    roleGroup: (employee.role_group || parsed.roleGroup) as EmployeeSession["roleGroup"],
    posRole: (employee.pos_role || parsed.posRole) as EmployeeSession["posRole"],
    sessionVersion: Number(employee.session_version || 1),
  };
}

export async function clearEmployeeSession(): Promise<void> {
  const store = await cookies();
  const session = await getEmployeeSession();
  if (session?.deviceSessionId) await getSql()`UPDATE employee_app_sessions SET ended_at=NOW(),last_seen_at=NOW() WHERE id=${session.deviceSessionId}`.catch(() => undefined);
  store.set(EMPLOYEE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 0,
  });
}
