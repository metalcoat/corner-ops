import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { legacySessionSecret, purposeKey } from "@/lib/security-keys";

function currentKey(): Buffer {
  return purposeKey("integration-credentials", {
    envName: "INTEGRATION_ENCRYPTION_KEY",
    fallbackEnvName: "EMPLOYMENT_FORMS_ENCRYPTION_KEY",
  });
}

function legacyKey(): Buffer {
  return createHash("sha256").update(`corner-ops-integrations:${legacySessionSecret()}`).digest();
}

function openParts(key: Buffer, ivText: string, tagText: string, encryptedText: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptIntegrationSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", currentKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v2", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptIntegrationSecret(value: string): string {
  if (!value) return "";
  const parts = value.split(".");
  if (parts[0] === "v2") {
    if (parts.length !== 4) throw new Error("Stored integration credential is invalid.");
    return openParts(currentKey(), parts[1], parts[2], parts[3]);
  }
  if (parts.length !== 3) throw new Error("Stored integration credential is invalid.");
  return openParts(legacyKey(), parts[0], parts[1], parts[2]);
}
