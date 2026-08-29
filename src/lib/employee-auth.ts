import { cookies } from "next/headers";
import { getSql } from "@/lib/db";
import { employeeByPin } from "@/lib/employee-pin-security";
import { AuthenticationError } from "@/lib/http";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";
import type { Business } from "@/lib/types";

const EMPLOYEE_COOKIE = "corner_ops_employee";
const EMPLOYEE_SESSION_SECONDS = 60 * 60 * 24 * 14;

export type EmployeeSession = {
  employeeId: string;
  business: Business;
  name: string;
  position: string;
  sessionVersion?: number;
  expiresAt: number;
};

function sign(value: string): string { return hmacSignature(value, "employee-session", { envName: "EMPLOYEE_SESSION_SECRET" }); }
function encode(payload: EmployeeSession): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}
function decode(token: string): EmployeeSession | null {
  const [body, supplied] = token.split(".");
  if (!body || !supplied) return null;
  let valid = false;
  try { valid = constantTimeEqual(sign(body), supplied) || constantTimeEqual(legacySessionHmac(body), supplied); } catch { return null; }
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EmployeeSession;
    if (!payload.employeeId || !payload.name || !payload.business || payload.expiresAt <= Date.now()) return null;
    return { ...payload, sessionVersion: Number(payload.sessionVersion || 1) };
  } catch { return null; }
}

export async function createEmployeeSession(business: Business, suppliedPin: string): Promise<EmployeeSession> {
  const employee = await employeeByPin(business, suppliedPin);
  if (!employee) throw new AuthenticationError("PIN not recognized for this location.");
  const payload: EmployeeSession = {
    employeeId: employee.id, business: employee.business, name: employee.name, position: employee.position,
    sessionVersion: Number(employee.session_version || 1), expiresAt: Date.now() + EMPLOYEE_SESSION_SECONDS * 1000,
  };
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, encode(payload), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: EMPLOYEE_SESSION_SECONDS,
  });
  return payload;
}

export async function getEmployeeSession(): Promise<EmployeeSession | null> {
  if (!process.env.EMPLOYEE_SESSION_SECRET && !process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(EMPLOYEE_COOKIE)?.value;
  const parsed = token ? decode(token) : null;
  if (!parsed) return null;
  const rows = await getSql()`
    SELECT id, business, name, position, session_version, active, pin_enabled
    FROM employees WHERE id = ${parsed.employeeId} AND business = ${parsed.business} LIMIT 1
  ` as unknown as Array<{ id: string; business: Business; name: string; position: string; session_version: number; active: boolean; pin_enabled: boolean }>;
  const employee = rows[0];
  if (!employee?.active || !employee.pin_enabled || Number(employee.session_version || 1) !== Number(parsed.sessionVersion || 1)) return null;
  return { ...parsed, name: employee.name, position: employee.position, sessionVersion: Number(employee.session_version || 1) };
}

export async function clearEmployeeSession(): Promise<void> {
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
}
