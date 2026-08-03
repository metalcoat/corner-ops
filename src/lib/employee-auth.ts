import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { ensureSchema, getSql } from "@/lib/db";
import { validateEmployeePin } from "@/lib/employee-pin";
import type { Business } from "@/lib/types";

const EMPLOYEE_COOKIE = "corner_ops_employee";
const EMPLOYEE_SESSION_SECONDS = 60 * 60 * 24 * 14;

export type EmployeeSession = {
  employeeId: string;
  business: Business;
  name: string;
  position: string;
  expiresAt: number;
};

type EmployeeRow = {
  id: string;
  business: Business;
  name: string;
  position: string;
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

function pinHash(business: Business, pin: string): string {
  return createHmac("sha256", secret()).update(`${business}:${pin}`).digest("hex");
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

export async function createEmployeeSession(business: Business, suppliedPin: string): Promise<EmployeeSession> {
  await ensureSchema();
  const pin = validateEmployeePin(business, suppliedPin, business);
  const rows = await getSql()`
    SELECT id, business, name, position
    FROM employees
    WHERE business = ${business}
      AND pin_hash = ${pinHash(business, pin)}
      AND active = TRUE
    LIMIT 1
  ` as unknown as EmployeeRow[];
  const employee = rows[0];
  if (!employee) throw new Error("PIN not recognized for this location.");

  const payload: EmployeeSession = {
    employeeId: employee.id,
    business: employee.business,
    name: employee.name,
    position: employee.position,
    expiresAt: Date.now() + EMPLOYEE_SESSION_SECONDS * 1000,
  };
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, encode(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: EMPLOYEE_SESSION_SECONDS,
  });
  return payload;
}

export async function getEmployeeSession(): Promise<EmployeeSession | null> {
  if (!process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(EMPLOYEE_COOKIE)?.value;
  return token ? decode(token) : null;
}

export async function clearEmployeeSession(): Promise<void> {
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
