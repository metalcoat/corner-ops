import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "corner_ops_session";
const publicPaths = [
  "/api/auth/session",
  "/api/timeclock",
  "/api/employee",
  "/api/employee/session",
  "/api/rezku/inbound",
  "/api/square/callback",
  "/api/square/webhook",
  "/api/cron/",
];

type Token = {
  email?: string;
  role?: string;
  permissions?: string[];
  expiresAt?: number;
};

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function token(request: NextRequest): Token | null {
  const raw = request.cookies.get(COOKIE_NAME)?.value;
  const secret = process.env.SESSION_SECRET;
  if (!raw || !secret) return null;

  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!equal(expected, supplied)) return null;

  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Token;
    if (Number(value.expiresAt || 0) <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

function needed(path: string, method: string): string | null {
  const write = method !== "GET" && method !== "HEAD";
  if (path.startsWith("/api/reports") || path.startsWith("/api/weather")) return "reports.read";
  if (path.startsWith("/api/accounting-control") || path.startsWith("/api/expense-control")) {
    return write ? "accounting.write" : "accounting.read";
  }
  if (path.startsWith("/api/payroll-control")) return write ? "payroll.write" : "payroll.read";
  if (path.startsWith("/api/users")) return "users.manage";
  if (path.startsWith("/api/integrations") || path.startsWith("/api/bank-accounts") || path.startsWith("/api/square/connect")) {
    return write ? "integrations.write" : "integrations.read";
  }
  if (path.startsWith("/api/workforce") || path.startsWith("/api/employee-directory") || path.startsWith("/api/attendance")) {
    return write ? "workforce.write" : "workforce.read";
  }
  if (path.startsWith("/api/documents") || path.startsWith("/api/audit")) {
    return write ? "documents.write" : "documents.read";
  }
  if (path.startsWith("/api/operations")) return write ? "payroll.write" : "payroll.read";
  return null;
}

function isOwnerSession(session: Token): boolean {
  if (session.role === "Owner" || session.role === "Co-Owner") return true;
  const configuredOwner = (process.env.APP_EMAIL || "crfrary@gmail.com").trim().toLowerCase();
  return !session.role && Boolean(session.email) && session.email!.trim().toLowerCase() === configuredOwner;
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (publicPaths.some((prefix) => path === prefix || path.startsWith(prefix))) return NextResponse.next();

  const session = token(request);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (isOwnerSession(session)) return NextResponse.next();

  const permission = needed(path, request.method);
  const permissions = session.permissions || [];
  if (permission && !permissions.includes("*") && !permissions.includes(permission)) {
    return NextResponse.json({ error: "Your account does not have permission for this action." }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
