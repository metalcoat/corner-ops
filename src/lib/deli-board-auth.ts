import { getSql } from "@/lib/db";
import { employeeByPin } from "@/lib/employee-pin-security";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";

const BUSINESS = "Corner Deli" as const;
const TOKEN_SECONDS = 60 * 60 * 24 * 30;
const SCOPE = "deli-board" as const;

export type DeliBoardTokenPayload = {
  scope: typeof SCOPE;
  business: typeof BUSINESS;
  employeeId: string;
  employeeName: string;
  sessionVersion?: number;
  expiresAt: number;
};

function sign(value: string): string { return hmacSignature(value, "deli-board-session", { envName: "DELI_BOARD_SESSION_SECRET" }); }
function encode(payload: DeliBoardTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export async function verifyDeliBoardToken(token: string | null | undefined): Promise<DeliBoardTokenPayload | null> {
  if (!token || (!process.env.DELI_BOARD_SESSION_SECRET && !process.env.SESSION_SECRET)) return null;
  const [body, supplied] = token.split(".");
  if (!body || !supplied) return null;
  let valid = false;
  try { valid = constantTimeEqual(sign(body), supplied) || constantTimeEqual(legacySessionHmac(body), supplied); } catch { return null; }
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DeliBoardTokenPayload;
    if (payload.scope !== SCOPE || payload.business !== BUSINESS || !payload.employeeId || !payload.employeeName || payload.expiresAt <= Date.now()) return null;
    const rows = await getSql()`
      SELECT name, session_version, active, pin_enabled FROM employees
      WHERE id = ${payload.employeeId} AND business = ${BUSINESS} LIMIT 1
    ` as unknown as Array<{ name: string; session_version: number; active: boolean; pin_enabled: boolean }>;
    const employee = rows[0];
    if (!employee?.active || !employee.pin_enabled || Number(employee.session_version || 1) !== Number(payload.sessionVersion || 1)) return null;
    return { ...payload, employeeName: employee.name, sessionVersion: Number(employee.session_version || 1) };
  } catch { return null; }
}

export async function createDeliBoardToken(suppliedPin: string) {
  const employee = await employeeByPin(BUSINESS, suppliedPin);
  if (!employee) throw new Error("PIN not recognized for Corner Deli.");
  const payload: DeliBoardTokenPayload = {
    scope: SCOPE, business: BUSINESS, employeeId: employee.id, employeeName: employee.name,
    sessionVersion: Number(employee.session_version || 1), expiresAt: Date.now() + TOKEN_SECONDS * 1000,
  };
  return { token: encode(payload), payload };
}
