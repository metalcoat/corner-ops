const requiredVariables = [
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "APP_PASSWORD",
  "SESSION_SECRET",
] as const;

export type DatabaseDriver = "neon" | "postgres";
export type StorageDriver = "vercel" | "local";

export function getDatabaseDriver(): DatabaseDriver {
  const value = process.env.DATABASE_DRIVER?.trim().toLowerCase() || "neon";
  if (value === "neon" || value === "postgres") return value;
  throw new ConfigurationError(["DATABASE_DRIVER"]);
}

export function getStorageDriver(): StorageDriver {
  const value = process.env.STORAGE_DRIVER?.trim().toLowerCase() || "vercel";
  if (value === "vercel" || value === "local") return value;
  throw new ConfigurationError(["STORAGE_DRIVER"]);
}

export function getLocalStoragePath(): string {
  return process.env.LOCAL_STORAGE_PATH?.trim() || "/data/uploads";
}

export function assertLocalRezkuImportAllowed(): void {
  const driver = getDatabaseDriver();
  const localDevelopment = process.env.LOCAL_DEVELOPMENT?.trim().toLowerCase() === "true";
  const importAllowed = process.env.ALLOW_REZKU_MENU_IMPORT?.trim().toLowerCase() === "true";
  if (driver !== "postgres" || !localDevelopment || !importAllowed) {
    throw new ConfigurationError(["DATABASE_DRIVER=postgres", "LOCAL_DEVELOPMENT=true", "ALLOW_REZKU_MENU_IMPORT=true"]);
  }
}

function isConfigured(name: (typeof requiredVariables)[number]): boolean {
  if (name === "BLOB_READ_WRITE_TOKEN") {
    if (getStorageDriver() === "local") return true;
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
