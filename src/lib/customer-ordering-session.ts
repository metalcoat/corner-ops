import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const COOKIE = "corner_customer_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type CustomerOrderingSession = {
  sessionId: string;
  customerId: string | null;
  authenticatedAt: number | null;
  expiresAt: number;
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("Customer ordering is not configured.");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: Request): string {
  const raw = request.headers.get("cookie") || "";
  return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
}

export function readCustomerOrderingSession(request: Request): CustomerOrderingSession | null {
  const [encoded, supplied] = cookieValue(request).split(".");
  if (!encoded || !supplied || !equal(sign(encoded), supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CustomerOrderingSession;
    if (!value.sessionId || value.expiresAt <= Date.now()) return null;
    return value;
  } catch { return null; }
}

export function customerOrderingSession(request: Request): { session: CustomerOrderingSession; setCookie: string | null } {
  const existing = readCustomerOrderingSession(request);
  if (existing) return { session: existing, setCookie: null };
  const session: CustomerOrderingSession = { sessionId: randomUUID(), customerId: null, authenticatedAt: null, expiresAt: Date.now() + MAX_AGE_SECONDS * 1000 };
  const encoded = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { session, setCookie: `${COOKIE}=${encoded}.${sign(encoded)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${process.env.NODE_ENV === "production" ? "; Secure" : ""}` };
}

export function customerSessionHash(sessionId: string): string {
  return createHash("sha256").update(`${secret()}:customer-order:${sessionId}`).digest("hex");
}
