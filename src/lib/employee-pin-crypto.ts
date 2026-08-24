import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { legacySessionSecret, purposeSecret } from "./security-keys";

export const EMPLOYEE_PIN_HASH_VERSION = 2;

function pepper(): string {
  return purposeSecret("employee-pin-pepper", {
    envName: "EMPLOYEE_PIN_PEPPER",
    fallbackEnvName: "EMPLOYMENT_FORMS_ENCRYPTION_KEY",
  });
}

export function legacyEmployeePinHash(business: string, pin: string): string {
  return createHmac("sha256", legacySessionSecret()).update(`${business}:${pin}`).digest("hex");
}

export function employeePinFingerprint(business: string, pin: string): string {
  return createHmac("sha256", pepper()).update(`${business}:${pin}`).digest("hex");
}

export function employeePinDigest(business: string, pin: string, salt: string): string {
  return scryptSync(`${business}:${pin}:${pepper()}`, salt, 32).toString("base64url");
}

export function createEmployeePinCryptoRecord(business: string, pin: string) {
  const salt = randomBytes(18).toString("base64url");
  return {
    hash: employeePinDigest(business, pin, salt),
    salt,
    version: EMPLOYEE_PIN_HASH_VERSION,
    fingerprint: employeePinFingerprint(business, pin),
  };
}
