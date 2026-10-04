// Guards for destructive local-development-only tools (bulk cash void, simulated card approvals).
// The local runtime runs `next start` with NODE_ENV=production (docker-compose.local.yml), so
// NODE_ENV alone cannot distinguish production; production is the Vercel deployment.

function hostOf(value: string | null | undefined): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try { return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname; } catch { return ""; }
}

export function isProductionHost(host: string | null | undefined): boolean {
  const name = hostOf(host);
  return name === "corner-ops.vercel.app" || name.endsWith(".vercel.app");
}

export function localDevToolsAllowed(env: Record<string, string | undefined> = process.env, requestHost?: string | null): boolean {
  if (env.LOCAL_DEVELOPMENT !== "true") return false;
  if (env.VERCEL || env.VERCEL_ENV) return false;
  if (isProductionHost(env.APP_URL)) return false;
  if (requestHost && isProductionHost(requestHost)) return false;
  return true;
}
