// Pure POS access helpers (no "@/..." imports) so they can be unit tested.

/**
 * Client IP as seen by Cloudflare. cf-connecting-ip is set by Cloudflare and
 * cannot be chosen by the client; the X-Forwarded-For fallback is used only
 * when the request did not come through Cloudflare (e.g. local terminals).
 */
export function requestIp(headers: Headers): string {
  return (headers.get("cf-connecting-ip") || headers.get("x-forwarded-for")?.split(",")[0] || headers.get("x-real-ip") || "")
    .trim().replace(/^::ffff:/, "").slice(0, 80);
}

export function localIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** Email approval links stay usable for 24 hours after the (latest) request. */
export const POS_ACCESS_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function approvalRequestOpen(
  row: { status?: unknown; requested_at?: unknown } | null | undefined,
  now = Date.now(),
): boolean {
  if (!row || row.status !== "pending") return false;
  const requestedAt = new Date(String(row.requested_at || "")).getTime();
  return Number.isFinite(requestedAt) && now - requestedAt <= POS_ACCESS_APPROVAL_TTL_MS && requestedAt <= now + 60_000;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/**
 * PIN lockout keys: one per client IP and one shared per business, so rotating
 * IPs or forged headers cannot brute-force the PIN space.
 */
export const POS_PIN_IP_MAX_FAILURES = 8;
export const POS_PIN_BUSINESS_MAX_FAILURES = 30;

export function pinAttemptKeys(headers: Headers, business = "Corner Deli") {
  const ip = requestIp(headers) || "local-terminal";
  return {
    ipKey: `ip:${ip}`.slice(0, 160),
    businessKey: `business:${business}`,
  };
}
