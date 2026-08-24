import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_DOMAIN = "corner-ops-keyring-v1";

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredLegacySessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("SESSION_SECRET is required.");
  return secret;
}

function rootSecret(envName?: string, fallbackEnvName?: string): string {
  const configured = envName ? process.env[envName]?.trim() : "";
  if (configured) return configured;
  const fallback = fallbackEnvName ? process.env[fallbackEnvName]?.trim() : "";
  return fallback || requiredLegacySessionSecret();
}

export function purposeKey(purpose: string, options: { envName?: string; fallbackEnvName?: string } = {}): Buffer {
  return createHmac("sha256", rootSecret(options.envName, options.fallbackEnvName))
    .update(`${KEY_DOMAIN}:${purpose}`)
    .digest();
}

export function purposeSecret(purpose: string, options: { envName?: string; fallbackEnvName?: string } = {}): string {
  return purposeKey(purpose, options).toString("base64url");
}

export function legacySessionSecret(): string {
  return requiredLegacySessionSecret();
}

export function hmacSignature(data: string, purpose: string, options: { envName?: string; fallbackEnvName?: string } = {}): string {
  return createHmac("sha256", purposeKey(purpose, options)).update(data).digest("base64url");
}

export function legacySessionHmac(data: string): string {
  return createHmac("sha256", requiredLegacySessionSecret()).update(data).digest("base64url");
}

function keyEncryptionKey(): Buffer {
  return purposeKey("application-key-encryption", {
    envName: "KEY_ENCRYPTION_KEY",
    fallbackEnvName: "EMPLOYMENT_FORMS_ENCRYPTION_KEY",
  });
}

export function sealApplicationSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function openApplicationSecret(value: string): string {
  const [version, ivText, tagText, encryptedText] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) throw new Error("Stored application key material is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", keyEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
