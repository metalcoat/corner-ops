import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "corner_ops_session";
const POS_COOKIE_NAME = "corner_ops_pos";
const publicPaths = [
  "/api/health",
  "/api/auth/session",
  "/api/auth/password-reset/",
  "/api/timeclock",
  "/api/employee",
  "/api/employee/session",
  "/api/employee/pin-reset/",
  "/api/pos/",
  "/api/rezku/inbound",
  "/api/3cx/inbound",
  "/api/square/callback",
  "/api/square/webhook",
  "/api/cron/",
  "/api/customer/",
];

type Token = {
  email?: string;
  role?: string;
  permissions?: string[];
  expiresAt?: number;
};

type PosToken = { employeeId?: string; business?: string; expiresAt?: number; clockInRequired?: boolean };

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

function posToken(request: NextRequest): PosToken | null {
  const raw = request.cookies.get(POS_COOKIE_NAME)?.value;
  const secret = process.env.SESSION_SECRET;
  if (!raw || !secret) return null;
  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!equal(expected, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PosToken;
    if (!value.employeeId || value.business !== "Corner Deli" || Number(value.expiresAt || 0) <= Date.now() || value.clockInRequired) return null;
    return value;
  } catch { return null; }
}

function isDeliPosApi(path: string): boolean {
  return path === "/api/ordering/menu"
    || path === "/api/ordering/orders"
    || path === "/api/ordering/kitchen"
    || path.startsWith("/api/ordering/order-center")
    || path.startsWith("/api/ordering/customers")
    || path.startsWith("/api/ordering/settings/")
    || path.startsWith("/api/ordering/reports")
    || path.startsWith("/api/ordering/barcodes")
    || path.startsWith("/api/ordering/gift-cards")
    || path.startsWith("/api/ordering/address/")
    || /^\/api\/ordering\/orders\/[^/]+\/submit$/.test(path);
}

function needed(path: string, method: string): string | null {
  const write = method !== "GET" && method !== "HEAD";
  if (path.startsWith("/api/reports") || path.startsWith("/api/weather") || path.startsWith("/api/3cx/calls")) return "reports.read";
  if (path.startsWith("/api/banking") || path.startsWith("/api/accounting-control") || path.startsWith("/api/expense-control")) {
    return write ? "accounting.write" : "accounting.read";
  }
  if (path.startsWith("/api/payroll-control") || path.startsWith("/api/rezku-monitor")) {
    return write ? "payroll.write" : "payroll.read";
  }
  if (path.startsWith("/api/users")) return "users.manage";
  if (path.startsWith("/api/integrations") || path.startsWith("/api/bank-accounts") || path.startsWith("/api/square/connect")) {
    return write ? "integrations.write" : "integrations.read";
  }
  if (path.startsWith("/api/messages") || path.startsWith("/api/workforce") || path.startsWith("/api/employee-directory") || path.startsWith("/api/attendance") || path.startsWith("/api/employment-forms") || path.startsWith("/api/direct-deposit")) {
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
  const allowed=(process.env.ALLOWED_HOSTS||"").split(",").map(v=>v.trim().toLowerCase()).filter(Boolean),host=(request.headers.get("x-forwarded-host")||request.headers.get("host")||"").split(":")[0].toLowerCase();
  if(allowed.length&&!allowed.includes(host)&&host!=="localhost"&&!/^127\./.test(host)&&!/^192\.168\./.test(host))return NextResponse.json({error:"Host not allowed."},{status:421});
  const response=NextResponse.next();response.headers.set("X-Robots-Tag","noindex, nofollow, noarchive");response.headers.set("X-Content-Type-Options","nosniff");response.headers.set("Referrer-Policy","same-origin");response.headers.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");response.headers.set("Content-Security-Policy","frame-ancestors 'none'");
  if(!path.startsWith("/api/"))return response;
  if (publicPaths.some((prefix) => path === prefix || path.startsWith(prefix))) return response;
  if (isDeliPosApi(path) && posToken(request)) return response;

  const session = token(request);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (isOwnerSession(session)) return response;

  const permission = needed(path, request.method);
  const permissions = session.permissions || [];
  if (permission && !permissions.includes("*") && !permissions.includes(permission)) {
    return NextResponse.json({ error: "Your account does not have permission for this action." }, { status: 403 });
  }
  return response;
}

export const config = { matcher: ["/:path*"] };
