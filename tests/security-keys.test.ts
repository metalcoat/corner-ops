import assert from "node:assert/strict";
import test from "node:test";

process.env.SESSION_SECRET = "legacy-session-secret-for-tests-only-not-a-production-value";
process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY = "test-employment-key-for-purpose-separation";

import { createEmployeePinRecord, employeePinFingerprint, legacyEmployeePinHash } from "../src/lib/employee-pin-security";
import { hmacSignature, legacySessionHmac, openApplicationSecret, sealApplicationSecret } from "../src/lib/security-keys";

test("purpose-specific session signatures differ from legacy SESSION_SECRET signatures", () => {
  const data = "payload";
  assert.notEqual(hmacSignature(data, "owner-session", { envName: "OWNER_SESSION_SECRET" }), legacySessionHmac(data));
  assert.notEqual(
    hmacSignature(data, "owner-session", { envName: "OWNER_SESSION_SECRET" }),
    hmacSignature(data, "employee-session", { envName: "EMPLOYEE_SESSION_SECRET" }),
  );
});

test("application secret sealing round trips without SESSION_SECRET as the encryption root", () => {
  const sealed = sealApplicationSecret("private-key-material");
  assert.notEqual(sealed, "private-key-material");
  assert.equal(openApplicationSecret(sealed), "private-key-material");
});

test("employee PIN v2 uses per-row salt while preserving a stable uniqueness fingerprint", () => {
  const first = createEmployeePinRecord("Corner Deli", "1234", "Test Employee");
  const second = createEmployeePinRecord("Corner Deli", "1234", "Test Employee");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, employeePinFingerprint("Corner Deli", "1234"));
  assert.notEqual(first.hash, legacyEmployeePinHash("Corner Deli", "1234"));
});
