// The public ordering site (ordercornerdeli.com). It serves only the customer
// pages and the customer API: never the owner office, POS, employee or any
// other API, so a customer-site bug can't reach staff sessions or tools.
// www.ordercornerdeli.com redirects to the bare name.

export const CUSTOMER_HOST = "ordercornerdeli.com";
export const CUSTOMER_WWW_HOST = "www.ordercornerdeli.com";

const CUSTOMER_PAGES = ["/order", "/menu", "/account", "/track", "/privacy", "/terms", "/refund-policy", "/sms-help"];
const CUSTOMER_FILES = ["/favicon.ico", "/corner-deli-logo.png", "/corner-ops-icon.svg", "/manifest.webmanifest", "/robots.txt"];

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isCustomerHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === CUSTOMER_HOST || host === CUSTOMER_WWW_HOST;
}

export function customerRoute(pathname: string): "allow" | "home" | "deny" {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/_next/") || pathname.startsWith("/icons/")) return "allow";
  if (CUSTOMER_FILES.includes(pathname)) return "allow";
  if (within(pathname, "/api/customer") || pathname === "/api/health") return "allow";
  return CUSTOMER_PAGES.some((prefix) => within(pathname, prefix)) ? "allow" : "deny";
}

/** Base URL for links sent to customers (delivery tracking texts). */
export function customerSiteBaseUrl(fallback: string): string {
  const configured = process.env.CUSTOMER_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return process.env.APP_ENV === "production" ? `https://${CUSTOMER_HOST}` : fallback;
}
