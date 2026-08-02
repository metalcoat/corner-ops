const requiredVariables = [
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "APP_PASSWORD",
  "SESSION_SECRET",
] as const;

function isConfigured(name: (typeof requiredVariables)[number]): boolean {
  if (name === "BLOB_READ_WRITE_TOKEN") {
    // New Blob connections on Vercel authenticate with short-lived OIDC
    // credentials instead of exposing a long-lived read/write token.
    return Boolean(
      process.env.BLOB_READ_WRITE_TOKEN?.trim()
      || process.env.VERCEL_OIDC_TOKEN?.trim()
      || process.env.VERCEL,
    );
  }

  return Boolean(process.env[name]?.trim());
}

export function getMissingConfiguration(): string[] {
  return requiredVariables.filter((name) => !isConfigured(name));
}

export function assertConfigured(...names: (typeof requiredVariables)[number][]): void {
  const missing = names.filter((name) => !isConfigured(name));
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
