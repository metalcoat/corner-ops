import type { Business } from "@/lib/types";

const HOSTS: Record<Business, string> = {
  "Corner Deli": "ops.ordercornerdeli.com",
  Tiki: "ops.atthedocks.com",
};

export function opsHostForBusiness(business: Business): string { return HOSTS[business]; }
export function businessForOpsHost(host: string): Business | null {
  if (host === HOSTS["Corner Deli"]) return "Corner Deli";
  if (host === HOSTS.Tiki) return "Tiki";
  return null;
}

export function safeOpsReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/ops/people";
  const parsed = new URL(value, "https://ops.ordercornerdeli.com");
  if (parsed.origin !== "https://ops.ordercornerdeli.com") return "/ops/people";
  const path = `${parsed.pathname}${parsed.search}`;
  return path === "/" || path.startsWith("/ops/") || path === "/ops" ? path : "/ops/people";
}
