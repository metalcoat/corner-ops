import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "corner_ops_session";

const selfAuthorizedApiPaths = [
  "/api/auth/session",
  "/api/auth/password-reset",
  "/api/timeclock",
  "/api/employee",
  "/api/deli-board",
  "/api/document-scan",
  "/api/push",
  "/api/rezku/inbound",
  "/api/rezku/download-proxy",
  "/api/3cx/inbound",
  "/api/square/callback",
  "/api/square/webhook",
  "/api/cron",
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

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function needed(path: string, method: string): string | null {
  const write = method !== "GET" && method !== "HEAD";

  if (matchesPath(path, "/api/reports") || matchesPath(path, "/api/weather") || matchesPath(path, "/api/3cx/calls")) {
    return "reports.read";
  }
  if (
    matchesPath(path, "/api/banking")
    || matchesPath(path, "/api/accounting-control")
    || matchesPath(path, "/api/expense-control")
    || matchesPath(path, "/api/card-statements")
    || matchesPath(path, "/api/finance-operations")
  ) {
    return write ? "accounting.write" : "accounting.read";
  }
  if (
    matchesPath(path, "/api/payroll-control")
    || matchesPath(path, "/api/rezku-monitor")
    || matchesPath(path, "/api/overtime-risk")
    || matchesPath(path, "/api/operations")
  ) {
    return write ? "payroll.write" : "payroll.read";
  }
  if (matchesPath(path, "/api/users")) return "users.manage";
  if (
    matchesPath(path, "/api/integrations")
    || matchesPath(path, "/api/bank-accounts")
    || matchesPath(path, "/api/square/connect")
  ) {
    return write ? "integrations.write" : "integrations.read";
  }
  if (
    matchesPath(path, "/api/messages")
    || matchesPath(path, "/api/workforce")
    || matchesPath(path, "/api/employee-directory")
    || matchesPath(path, "/api/attendance")
    || matchesPath(path, "/api/employment-forms")
    || matchesPath(path, "/api/direct-deposit")
    || matchesPath(path, "/api/employment-handbook")
  ) {
    return write ? "workforce.write" : "workforce.read";
  }
  if (matchesPath(path, "/api/documents") || matchesPath(path, "/api/audit")) {
    return write ? "documents.write" : "documents.read";
  }
  return null;
}

function isOwnerSession(session: Token): boolean {
  return session.role === "Owner" || session.role === "Co-Owner";
}

function unauthorizedApi() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (path.startsWith("/api/")) {
    if (selfAuthorizedApiPaths.some((prefix) => matchesPath(path, prefix))) return NextResponse.next();

    const session = token(request);
    if (!session) return unauthorizedApi();
    if (isOwnerSession(session)) return NextResponse.next();

    const permission = needed(path, request.method);
    if (!permission) {
      return NextResponse.json({ error: "This API route is not assigned an authorization policy." }, { status: 403 });
    }
    const permissions = session.permissions || [];
    if (!permissions.includes("*") && !permissions.includes(permission)) {
      return NextResponse.json({ error: "Your account does not have permission for this action." }, { status: 403 });
    }
    return NextResponse.next();
  }

  if (path === "/ops" || path.startsWith("/ops/")) {
    if (token(request)) return NextResponse.next();
    const signin = new URL("/signin", request.url);
    signin.searchParams.set("returnTo", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(signin);
  }

  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/ops/:path*"] };
