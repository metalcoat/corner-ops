import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { historicalPurposeKey, legacySessionSecret, purposeSecret } from "./security-keys";
import { isProductionEnvironment } from "./production-security";

export const EMPLOYEE_PIN_HASH_VERSION = 2;

function pepperCandidates(): [string, string, string] {
  const current = purposeSecret("employee-pin-pepper", {
    envName: "EMPLOYEE_PIN_PEPPER", fallbackEnvName: "EMPLOYMENT_FORMS_ENCRYPTION_KEY",
  });
  const production = isProductionEnvironment();
  const roots = [
    process.env.LEGACY_EMPLOYEE_PIN_PEPPER || (!production ? process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY : ""),
    process.env.LEGACY_EMPLOYEE_PIN_PEPPER_2 || (!production ? process.env.SESSION_SECRET : ""),
  ];
  return [current, ...roots.map((root) => root?.trim()
    ? historicalPurposeKey("employee-pin-pepper", root).toString("base64url") : current)] as [string, string, string];
}

function pepper(): string {
  return pepperCandidates()[0];
}

function fingerprintWithPepper(business: string, pin: string, selectedPepper: string): string {
  return createHmac("sha256", selectedPepper).update(`${business}:${pin}`).digest("hex");
}

export function legacyEmployeePinHash(business: string, pin: string): string {
  return createHmac("sha256", legacySessionSecret()).update(`${business}:${pin}`).digest("hex");
}

export function employeePinFingerprint(business: string, pin: string): string {
  return fingerprintWithPepper(business, pin, pepper());
}

export function employeePinFingerprintCandidates(business: string, pin: string): [string, string, string] {
  const [currentPepper, employmentFormsPepper, sessionPepper] = pepperCandidates();
  return [
    fingerprintWithPepper(business, pin, currentPepper),
    fingerprintWithPepper(business, pin, employmentFormsPepper),
    fingerprintWithPepper(business, pin, sessionPepper),
  ];
}

export function employeePinDigestForCandidate(
  business: string,
  pin: string,
  salt: string,
  candidateIndex: number,
): string {
  const candidates = pepperCandidates();
  const selectedPepper = candidates[candidateIndex] || candidates[0];
  return scryptSync(`${business}:${pin}:${selectedPepper}`, salt, 32).toString("base64url");
}

export function employeePinDigest(business: string, pin: string, salt: string): string {
  return employeePinDigestForCandidate(business, pin, salt, 0);
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
