const requiredVariables = [
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "APP_PASSWORD",
  "SESSION_SECRET",
] as const;

export function getMissingConfiguration(): string[] {
  return requiredVariables.filter((name) => !process.env[name]?.trim());
}

export function assertConfigured(...names: (typeof requiredVariables)[number][]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }
}

export class ConfigurationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing configuration: ${missing.join(", ")}`);
    this.name = "ConfigurationError";
  }
}
