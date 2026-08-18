import { createHmac, timingSafeEqual } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { validateEmployeePin } from "@/lib/employee-pin";

const BUSINESS = "Corner Deli" as const;
const TOKEN_SECONDS = 60 * 60 * 24 * 30;
const SCOPE = "deli-board" as const;

export type DeliBoardTokenPayload = {
  scope: typeof SCOPE;
  business: typeof BUSINESS;
  employeeId: string;
  employeeName: string;
  expiresAt: number;
};

type EmployeeRow = {
  id: string;
  name: string;
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

function pinHash(pin: string): string {
  return createHmac("sha256", secret()).update(`${BUSINESS}:${pin}`).digest("hex");
}

function encode(payload: DeliBoardTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyDeliBoardToken(token: string | null | undefined): DeliBoardTokenPayload | null {
  if (!token || !process.env.SESSION_SECRET) return null;
  const [body, supplied] = token.split(".");
  if (!body || !supplied || !safeEqual(sign(body), supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DeliBoardTokenPayload;
    if (payload.scope !== SCOPE || payload.business !== BUSINESS || !payload.employeeId || !payload.employeeName || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createDeliBoardToken(suppliedPin: string) {
  await ensureSchema();
  const pin = validateEmployeePin(BUSINESS, suppliedPin, BUSINESS);
  const rows = await getSql()`
    SELECT id, name
    FROM employees
    WHERE business = ${BUSINESS}
      AND pin_hash = ${pinHash(pin)}
      AND active = TRUE
    LIMIT 1
  ` as unknown as EmployeeRow[];
  const employee = rows[0];
  if (!employee) throw new Error("PIN not recognized for Corner Deli.");

  const payload: DeliBoardTokenPayload = {
    scope: SCOPE,
    business: BUSINESS,
    employeeId: employee.id,
    employeeName: employee.name,
    expiresAt: Date.now() + TOKEN_SECONDS * 1000,
  };
  return { token: encode(payload), payload };
}
