const TEAM_HOSTS = new Set(["team.ordercornerdeli.com", "team.atthedocks.com"]);

const TEAM_PAGES = [
  "/team", "/employee", "/clock", "/scan", "/signin", "/forgot-password",
  "/reset-password", "/privacy", "/terms", "/sms-help",
  "/ops/attendance", "/ops/direct-deposit", "/ops/employee-handbook",
  "/ops/employees", "/ops/employment-forms", "/ops/messages",
  "/ops/overtime", "/ops/payroll-control", "/ops/payroll-tip-audit",
  "/ops/workforce", "/ops/tiki-time-corrections",
];

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isTeamHost(hostname: string): boolean {
  return TEAM_HOSTS.has(hostname.toLowerCase());
}

export function teamRoute(pathname: string): "allow" | "home" | "deny" {
  if (pathname === "/" || pathname === "/ops" || pathname === "/ops/people") return "home";
  if (pathname.startsWith("/_next/") || pathname.startsWith("/icons/")) return "allow";
  if (["/favicon.ico", "/corner-ops-icon.svg", "/manifest.webmanifest", "/sw.js"].includes(pathname)) return "allow";
  // API handlers keep their existing authentication and business checks. Never
  // expose a future POS or ordering API through a team host before migration.
  if (pathname.startsWith("/api/")) {
    return ["/api/order", "/api/ordering", "/api/pos", "/api/payments", "/api/helcim"]
      .some((prefix) => within(pathname, prefix)) ? "deny" : "allow";
  }
  return TEAM_PAGES.some((prefix) => within(pathname, prefix)) ? "allow" : "deny";
}
