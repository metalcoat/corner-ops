import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { legacySessionSecret, purposeSecret } from "./security-keys";

export const EMPLOYEE_PIN_HASH_VERSION = 2;

function pepperCandidates(): [string, string, string] {
  return [
    purposeSecret("employee-pin-pepper", {
      envName: "EMPLOYEE_PIN_PEPPER",
      fallbackEnvName: "EMPLOYMENT_FORMS_ENCRYPTION_KEY",
    }),
    purposeSecret("employee-pin-pepper", { envName: "EMPLOYMENT_FORMS_ENCRYPTION_KEY" }),
    purposeSecret("employee-pin-pepper"),
  ];
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
