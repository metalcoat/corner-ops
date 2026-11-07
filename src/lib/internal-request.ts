/**
 * A request made on the box itself (the scheduled jobs, the supplier price job, health checks): it names the app
 * by an internal host and did not come through Cloudflare. Plain HTTP is expected there, so it must not be
 * redirected to HTTPS. (Next.js marks every direct request x-forwarded-proto=http, and inside the container the
 * request URL's host is always the bind address 0.0.0.0, so neither tells internal callers apart from visitors.)
 */
export function isInternalRequest(headers: { get(name: string): string | null }): boolean {
  if (headers.get("cf-connecting-ip") || headers.get("cf-visitor")) return false;
  const host = (headers.get("host") || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "host.docker.internal" ||
    // Docker service and container names: app, corner-ops-app
    !host.includes(".") ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  );
}
