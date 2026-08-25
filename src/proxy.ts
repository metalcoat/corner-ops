import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "corner_ops_session";
const POS_COOKIE_NAME = "corner_ops_pos";
const selfAuthorizedApiPaths = [
  "/api/health", "/api/auth/session", "/api/auth/password-reset",
  "/api/timeclock", "/api/employee", "/api/employee/session",
  "/api/employee/pin-reset", "/api/pos", "/api/deli-board",
  "/api/document-scan", "/api/push", "/api/rezku/inbound",
  "/api/3cx/inbound", "/api/openai", "/api/square/callback",
  "/api/square/webhook", "/api/cron", "/api/customer", "/api/driver",
  "/api/ordering/store-dashboard",
];

type Token = { email?: string; role?: string; permissions?: string[]; expiresAt?: number };
type PosToken = { employeeId?: string; business?: string; expiresAt?: number; clockInRequired?: boolean };

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signedValue<T>(request: NextRequest, cookieName: string): T | null {
  const raw = request.cookies.get(cookieName)?.value;
  const secret = process.env.SESSION_SECRET;
  if (!raw || !secret) return null;
  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!equal(expected, supplied)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function token(request: NextRequest): Token | null {
  const value = signedValue<Token>(request, COOKIE_NAME);
  return value && Number(value.expiresAt || 0) > Date.now() ? value : null;
}

function posToken(request: NextRequest): PosToken | null {
  const value = signedValue<PosToken>(request, POS_COOKIE_NAME);
  if (!value || !value.employeeId || value.business !== "Corner Deli" ||
      Number(value.expiresAt || 0) <= Date.now() || value.clockInRequired) return null;
  return value;
}

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isDeliPosApi(path: string): boolean {
  return path === "/api/ordering/menu" || matchesPath(path, "/api/ordering/orders") ||
    path === "/api/ordering/kitchen" ||
    ["order-center", "customers", "settings", "reports", "barcodes", "gift-cards", "address"]
      .some((part) => matchesPath(path, `/api/ordering/${part}`)) ||
    path === "/api/ordering/delivery/quote" ||
    path === "/api/ordering/hardware/status";
}

function anyPath(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => matchesPath(path, prefix));
}

function needed(path: string, method: string): string | null {
  const write = method !== "GET" && method !== "HEAD";
  if (anyPath(path, ["/api/reports", "/api/weather", "/api/3cx/calls"])) return "reports.read";
  if (anyPath(path, ["/api/banking", "/api/accounting-control", "/api/expense-control",
    "/api/card-statements", "/api/finance-operations"])) {
    return write ? "accounting.write" : "accounting.read";
  }
  if (anyPath(path, ["/api/payroll-control", "/api/rezku-monitor", "/api/overtime-risk", "/api/operations"])) {
    return write ? "payroll.write" : "payroll.read";
  }
  if (matchesPath(path, "/api/users")) return "users.manage";
  if (anyPath(path, ["/api/integrations", "/api/bank-accounts", "/api/square/connect"])) {
    return write ? "integrations.write" : "integrations.read";
  }
  if (anyPath(path, ["/api/messages", "/api/workforce", "/api/employee-directory",
    "/api/attendance", "/api/employment-forms", "/api/direct-deposit"])) {
    return write ? "workforce.write" : "workforce.read";
  }
  if (anyPath(path, ["/api/documents", "/api/audit"])) {
    return write ? "documents.write" : "documents.read";
  }
  return null;
}

function securedResponse(request: NextRequest): NextResponse {
  const allowed = (process.env.ALLOWED_HOSTS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "")
    .split(":")[0].toLowerCase();
  if (allowed.length && !allowed.includes(host) && host !== "localhost" &&
      !/^127\./.test(host) && !/^192\.168\./.test(host)) {
    return NextResponse.json({ error: "Host not allowed." }, { status: 421 });
  }
  const response = NextResponse.next();
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=(self)");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return response;
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const response = securedResponse(request);
  if (response.status === 421) return response;

  if (path.startsWith("/api/")) {
    if (selfAuthorizedApiPaths.some((prefix) => matchesPath(path, prefix))) return response;
    if (isDeliPosApi(path) && posToken(request)) return response;
    const session = token(request);
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    if (session.role === "Owner" || session.role === "Co-Owner") return response;
    const permission = needed(path, request.method);
    if (!permission) {
      return NextResponse.json({ error: "This API route is not assigned an authorization policy." }, { status: 403 });
    }
    const permissions = session.permissions || [];
    if (!permissions.includes("*") && !permissions.includes(permission)) {
      return NextResponse.json({ error: "Your account does not have permission for this action." }, { status: 403 });
    }
    return response;
  }

  if (matchesPath(path, "/ops")) {
    if (token(request)) return response;
    const signin = new URL("/signin", request.url);
    signin.searchParams.set("returnTo", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(signin);
  }
  return response;
}

export const config = { matcher: ["/:path*"] };
