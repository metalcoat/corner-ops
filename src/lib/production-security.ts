import { secretStrengthError } from "./secret-strength";

export const dedicatedProductionSecrets = [
  "OWNER_SESSION_SECRET", "EMPLOYEE_SESSION_SECRET", "DELI_BOARD_SESSION_SECRET",
  "EMPLOYEE_PIN_PEPPER", "INTEGRATION_ENCRYPTION_KEY", "KEY_ENCRYPTION_KEY",
  "EMPLOYMENT_FORMS_ENCRYPTION_KEY", "SQUARE_OAUTH_STATE_SECRET", "CRON_SECRET",
] as const;

type Environment = Record<string, string | undefined>;
export function isProductionEnvironment(env: Environment = process.env): boolean {
  return env.VERCEL_ENV === "production"
    || (env.NODE_ENV === "production" && !["preview", "development"].includes(env.VERCEL_ENV || ""));
}

export function productionSecurityErrors(env: Environment = process.env): string[] {
  if (!isProductionEnvironment(env)) return [];
  const errors: string[] = [];
  const used = new Map<string, string>();
  if (env.SESSION_SECRET?.trim()) used.set(env.SESSION_SECRET.trim(), "SESSION_SECRET");
  for (const name of dedicatedProductionSecrets) {
    const value = env[name]?.trim() || "";
    const strength = secretStrengthError(value, name);
    if (strength) errors.push(strength);
    if (value && used.has(value)) errors.push(`${name} must not reuse ${used.get(value)}.`);
    if (value) used.set(value, name);
  }
  return errors;
}

export function assertProductionSecurity(env: Environment = process.env): void {
  const errors = productionSecurityErrors(env);
  if (errors.length) throw new Error(`Production security configuration is incomplete: ${errors.join(" ")}`);
}
