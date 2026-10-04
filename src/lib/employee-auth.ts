import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { employeeByPin } from "@/lib/employee-pin-security";
import { cookies } from "next/headers";
import { ensureSchema, getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import type { Business } from "@/lib/types";
import { secureCookies } from "@/lib/cookie-security";

const EMPLOYEE_COOKIE = "corner_ops_employee";
const EMPLOYEE_SESSION_SECONDS = 60 * 60 * 24 * 14;

export type EmployeeSession = {
  employeeId: string;
  business: Business;
  name: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  posRole: "employee" | "manager" | "owner";
  deviceSessionId: string;
  expiresAt: number;
};

type EmployeeRow = {
  id: string;
  business: Business;
  name: string;
  position: string;
  role_group: "Driver" | "In-House" | "Ignore";
  pos_role: "employee" | "manager" | "owner";
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required.");
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function encode(payload: EmployeeSession): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): EmployeeSession | null {
  const [body, supplied] = token.split(".");
  if (!body || !supplied || !safeEqual(sign(body), supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EmployeeSession;
    if (!payload.employeeId || !payload.name || !payload.business || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createEmployeeSession(business: Business, suppliedPin: string, device: { label?: string; userAgent?: string } = {}): Promise<EmployeeSession> {
  await ensureSchema();
  await ensureEmployeeDirectorySchema();
  await getSql()`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pos_role TEXT NOT NULL DEFAULT 'employee'`;
  const match = await employeeByPin(business, suppliedPin);
  const rows = match ? [match] as unknown as EmployeeRow[] : [];
  const employee = rows[0];
  if (!employee) throw new Error("PIN not recognized for this location.");

  const payload: EmployeeSession = {
    employeeId: employee.id,
    business: employee.business,
    name: employee.name,
    position: employee.position,
    roleGroup: employee.role_group,
    posRole: employee.pos_role,
    deviceSessionId: randomUUID(),
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
  if (!process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(EMPLOYEE_COOKIE)?.value;
  return token ? decode(token) : null;
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
