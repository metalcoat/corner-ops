/**
 * Authentication cookies default to Secure unless the configured application
 * origin explicitly uses plain HTTP. COOKIE_SECURE can override this for
 * controlled deployments without coupling cookie behavior to NODE_ENV.
 */
export function secureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.COOKIE_SECURE?.trim().toLowerCase();
  if (override === "true" || override === "1" || override === "yes") return true;
  if (override === "false" || override === "0" || override === "no") return false;

  const configured = env.APP_URL?.trim();
  if (!configured) return true;
  try {
    return new URL(configured).protocol !== "http:";
  } catch {
    return true;
  }
}
