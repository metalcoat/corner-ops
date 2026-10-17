import { createHmac, timingSafeEqual } from "node:crypto";
import { isInternalRequest } from "@/lib/internal-request";
import { hmacSignature } from "@/lib/security-keys";
import { isTeamHost, teamRoute } from "@/lib/team-domain-routing";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "corner_ops_session";
const POS_COOKIE_NAME = "corner_ops_pos";
const POS_NETWORK_COOKIE_NAME = "corner_ops_pos_network";
const removedVendorPaths = [
  "/api/square",
  "/api/rezku",
  "/api/rezku-monitor",
  "/api/ordering/import/rezku",
  "/ops/rezku-monitor",
];
// When APP_ENV=production, only the public business hosts (and on-box callers)
// are served; any other Host header gets a 404. Mirrors the production release.
const PRODUCTION_HOSTS = new Set([
  "ops.ordercornerdeli.com",
  "ops.atthedocks.com",
  "team.ordercornerdeli.com",
  "team.atthedocks.com",
  "localhost",
  "127.0.0.1",
]);
const selfAuthorizedApiPaths = [
  "/api/health",
  "/api/auth/session",
  // Ops-domain business switch: the start route checks the session itself and
  // the completion route is authorized by its one-time code.
  "/api/auth/ops-switch",
  // Telnyx verifies its own ed25519 webhook signature in the route.
  "/api/telnyx/inbound",
  "/api/auth/password-reset",
  "/api/timeclock",
  "/api/employee",
  "/api/employee/session",
  "/api/employee/pin-reset",
  "/api/pos",
  "/api/deli-board",
  "/api/document-scan",
  "/api/push",
  "/api/3cx/inbound",
  "/api/3cx/crm/lookup",
  "/api/3cx/deli-ring",
  "/api/3cx/ai-ring",
  "/api/openai",
  "/api/cron",
  "/api/customer",
  "/api/driver",
  "/api/ordering/store-dashboard",
  "/api/mobile/android/version",
  "/api/ordering/customer-display",
  // Tablet setup lists station and label printer names before anyone signs
  // in; it is still limited to approved POS networks by isDeliPosApi.
  "/api/ordering/device-setup",
  // The label station checks its own sign-in (an employee or its screen pass).
  "/api/ordering/labels",
  "/api/pizza-gauntlet/run",
  "/api/pizza-gauntlet/leaderboard",
  "/api/delivery-boy/run",
  "/api/delivery-boy/leaderboard",
  "/api/games/leaderboard",
  "/api/games/analytics",
  "/api/internal/voice-payment",
  "/api/internal/ai-phone",
];

type Token = {
  email?: string;
  role?: string;
  permissions?: string[];
  expiresAt?: number;
};
type PosToken = {
  employeeId?: string;
  business?: string;
  expiresAt?: number;
  clockInRequired?: boolean;
};
type PosNetworkToken = { ip?: string; expiresAt?: number };

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cookies are signed with SESSION_SECRET. The owner cookie may instead carry
 * production's purpose-specific "owner-session" key (see security-keys), so
 * both are accepted.
 */
function signedValue<T>(request: NextRequest, cookieName: string, purpose?: { name: string; envName: string }): T | null {
  const raw = request.cookies.get(cookieName)?.value;
  const secret = process.env.SESSION_SECRET;
  if (!raw || !secret) return null;
  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;
  const expected = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  let valid = equal(expected, supplied);
  if (!valid && purpose) {
    try {
      valid = equal(hmacSignature(encoded, purpose.name, { envName: purpose.envName }), supplied);
    } catch {
      valid = false;
    }
  }
  if (!valid) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function token(request: NextRequest): Token | null {
  const value = signedValue<Token>(request, COOKIE_NAME, { name: "owner-session", envName: "OWNER_SESSION_SECRET" });
  return value && Number(value.expiresAt || 0) > Date.now() ? value : null;
}

function posToken(request: NextRequest): PosToken | null {
  const value = signedValue<PosToken>(request, POS_COOKIE_NAME);
  if (
    !value ||
    !value.employeeId ||
    value.business !== "Corner Deli" ||
    Number(value.expiresAt || 0) <= Date.now()
  )
    return null;
  return value;
}

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    request.headers.get("x-real-ip") ||
    ""
  )
    .trim()
    .replace(/^::ffff:/, "");
}

function localNetwork(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function posNetworkAllowed(request: NextRequest): boolean {
  const ip = clientIp(request);
  if (localNetwork(ip)) return true;
  const value = signedValue<PosNetworkToken>(request, POS_NETWORK_COOKIE_NAME);
  return Boolean(value?.ip === ip && Number(value.expiresAt || 0) > Date.now());
}

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isDeliPosApi(path: string): boolean {
  return (
    matchesPath(path, "/api/ordering/menu") ||
    matchesPath(path, "/api/ordering/orders") ||
    path === "/api/ordering/kitchen" ||
    [
      "order-center",
      "customers",
      "settings",
      "reports",
      "barcodes",
      "gift-cards",
      "address",
      "driver-cash",
      "calls",
      "availability",
      "employee-meals",
      "customer-credits",
      "brand-logo",
      "inventory",
      "supplier-costs",
      "register",
      "offline-sync",
      "payment-stations",
      "payments",
      "tips",
      "labels",
      "device-setup",
    ].some((part) => matchesPath(path, `/api/ordering/${part}`)) ||
    path === "/api/ordering/delivery/quote" ||
    path === "/api/ordering/hardware/status" ||
    path === "/api/ordering/store-dashboard" ||
    // Counter customer display: shows live orders/customer email and accepts
    // tips, signatures, and receipt choices, so it must stay on POS networks.
    path === "/api/ordering/customer-display"
  );
}

function anyPath(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => matchesPath(path, prefix));
}

function needed(path: string, method: string): string | null {
  const write = method !== "GET" && method !== "HEAD";
  if (anyPath(path, ["/api/reports", "/api/weather", "/api/3cx/calls"]))
    return "reports.read";
  if (
    anyPath(path, [
      "/api/banking",
      "/api/accounting-control",
      "/api/expense-control",
      "/api/card-statements",
      "/api/finance-operations",
    ])
  ) {
    return write ? "accounting.write" : "accounting.read";
  }
  if (
    anyPath(path, [
      "/api/payroll-control",
      "/api/overtime-risk",
      "/api/operations",
    ])
  ) {
    return write ? "payroll.write" : "payroll.read";
  }
  if (matchesPath(path, "/api/users")) return "users.manage";
  if (anyPath(path, ["/api/integrations", "/api/bank-accounts"])) {
    return write ? "integrations.write" : "integrations.read";
  }
  if (
    anyPath(path, [
      "/api/messages",
      "/api/workforce",
      "/api/employee-directory",
      "/api/attendance",
      "/api/employment-forms",
      "/api/direct-deposit",
      "/api/employment-handbook",
    ])
  ) {
    return write ? "workforce.write" : "workforce.read";
  }
  if (anyPath(path, ["/api/documents", "/api/audit"])) {
    return write ? "documents.write" : "documents.read";
  }
  return null;
}

function visitorHost(request: NextRequest): string {
  return (request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host)
    .split(",")[0]
    .trim()
    .replace(/:\d+$/, "")
    .toLowerCase();
}

function securedResponse(request: NextRequest): NextResponse {
  const allowed = (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const host = (
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    ""
  )
    .split(":")[0]
    .toLowerCase();
  if (
    allowed.length &&
    !allowed.includes(host) &&
    host !== "localhost" &&
    !/^127\./.test(host) &&
    !/^192\.168\./.test(host)
  ) {
    return NextResponse.json({ error: "Host not allowed." }, { status: 421 });
  }
  const response = NextResponse.next();
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=(self)",
  );
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return response;
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    process.env.APP_ENV === "production" &&
    !PRODUCTION_HOSTS.has(visitorHost(request)) &&
    !isInternalRequest(request.headers)
  ) {
    return new Response(null, { status: 404 });
  }
  const insecureForward =
    request.headers.get("x-forwarded-proto") === "http" ||
    request.headers.get("cf-visitor")?.includes('"scheme":"http"');
  if (
    path !== "/api/health" &&
    insecureForward &&
    !isInternalRequest(request.headers) &&
    !request.nextUrl.hostname.match(/^(localhost|127\.|192\.168\.)/)
  ) {
    // Inside the container nextUrl's host is the bind address (0.0.0.0:3000); send the visitor to the public name.
    const secure = request.nextUrl.clone();
    secure.protocol = "https:";
    secure.host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || secure.host).split(",")[0].trim();
    secure.port = "";
    return NextResponse.redirect(secure, 308);
  }
  if (removedVendorPaths.some((prefix) => matchesPath(path, prefix))) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const response = securedResponse(request);
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  if (response.status === 421) return response;

  // Team domains only serve workforce features. Inside the container nextUrl's
  // host is the bind address, so read the visitor's host from the headers.
  const host = visitorHost(request);
  if (isTeamHost(host)) {
    const route = teamRoute(path);
    if (route === "deny") return new Response(null, { status: 404 });
    if (route === "home") {
      const home = request.nextUrl.clone();
      home.pathname = "/team";
      home.search = "";
      home.protocol = "https:";
      home.host = host;
      home.port = "";
      return NextResponse.redirect(home);
    }
  }

  const posAccessRoute =
    matchesPath(path, "/api/pos/access") || path === "/pos/access";
  const posPage = matchesPath(path, "/pos");
  const posApi = matchesPath(path, "/api/pos") || isDeliPosApi(path);
  if (!posAccessRoute && (posPage || posApi) && !posNetworkAllowed(request)) {
    if (path.startsWith("/api/"))
      return NextResponse.json(
        { error: "This network is not approved for POS access." },
        { status: 403 },
      );
    return NextResponse.redirect(new URL("/pos/access", request.url));
  }

  if (path.startsWith("/api/")) {
    if (selfAuthorizedApiPaths.some((prefix) => matchesPath(path, prefix)))
      return response;
    if (matchesPath(path, "/api/ordering/manager-remakes")) {
      const session = token(request);
      return session && ["Owner", "Co-Owner", "Manager"].includes(String(session.role))
        ? response
        : NextResponse.json({ error: "Manager access required." }, { status: 403 });
    }
    if (isDeliPosApi(path) && posToken(request)) return response;
    const session = token(request);
    if (!session)
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    if (session.role === "Owner" || session.role === "Co-Owner")
      return response;
    const permission = needed(path, request.method);
    if (!permission) {
      return NextResponse.json(
        { error: "This API route is not assigned an authorization policy." },
        { status: 403 },
      );
    }
    const permissions = session.permissions || [];
    if (!permissions.includes("*") && !permissions.includes(permission)) {
      return NextResponse.json(
        { error: "Your account does not have permission for this action." },
        { status: 403 },
      );
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
