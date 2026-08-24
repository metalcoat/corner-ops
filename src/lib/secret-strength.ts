const FORBIDDEN_SECRET_MARKERS = [
  "placeholder",
  "changeme",
  "change-me",
  "example",
  "github-actions",
  "test-only",
  "development-only",
  "password123",
] as const;

export function secretStrengthError(value: unknown, name: string, minimumBytes = 32): string | null {
  const secret = String(value ?? "").trim();
  if (Buffer.byteLength(secret, "utf8") < minimumBytes) {
    return `${name} must contain at least ${minimumBytes} bytes of key material.`;
  }
  const normalized = secret.toLowerCase();
  if (FORBIDDEN_SECRET_MARKERS.some((marker) => normalized.includes(marker))) {
    return `${name} looks like a placeholder or development credential.`;
  }
  if (new Set(secret).size < 16) {
    return `${name} does not contain enough character diversity for encryption key material.`;
  }
  if (/^(.)\1+$/.test(secret) || /^(0123456789|1234567890|abcdefghijklmnopqrstuvwxyz)+$/i.test(secret)) {
    return `${name} is too predictable for encryption key material.`;
  }
  return null;
}

export function requireStrongSecret(value: unknown, name: string, minimumBytes = 32): string {
  const error = secretStrengthError(value, name, minimumBytes);
  if (error) throw new Error(error);
  return String(value).trim();
}
