import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { dedicatedProductionSecrets, productionSecurityErrors } from "../src/lib/production-security";
import { parsePunchCommand, isPunchReceipt } from "../src/lib/timeclock-contract";
import { locationReview } from "../src/lib/timeclock-location";
import { readPendingPunch, rememberPunch } from "../src/app/timeclock-pending";
import { hmacSignature, legacySessionHmac, purposeKey, sealApplicationSecret, openApplicationSecret, historicalPurposeKey } from "../src/lib/security-keys";

const nativeRequire = createRequire(__filename);
// Execute actual route code with explicit boundaries, not a copy of its policy.
function loadSource(path: string, mocks: Record<string, unknown>) {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, process, console, Response,
    require: (name: string) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith("node:")) return nativeRequire(name);
      throw new Error(`Unmocked dependency: ${name}`);
    } }, { filename: path });
  return module.exports;
}
const http = loadSource("src/lib/http.ts", { "@/lib/config": { ConfigurationError: class extends Error {} } });
const users = loadSource("src/lib/users.ts", { "@/lib/db": {} });
const auth = loadSource("src/lib/auth.ts", { "next/headers": {}, "@/lib/db": {}, "@/lib/http": http,
  "@/lib/security-keys": {}, "@/lib/types": { businesses: ["Tiki", "Corner Deli"] }, "@/lib/users": users });

for (const role of ["Viewer", "Manager", "Accountant", "Owner", "Co-Owner"]) {
  test(`${role}: direct-deposit sensitive reads require a separate permission`, async () => {
    let decrypted = 0; let audits = 0;
    const session = { email: "test@example.invalid", displayName: "Test", role,
      businesses: ["Tiki"], permissions: users.permissionsForRole(role) };
    const route = loadSource("src/app/api/direct-deposit/route.ts", {
      "next/server": { NextResponse: Response },
      "@/lib/auth": { ...auth, getSession: async () => session },
      "@/lib/http": http,
      "@/lib/audit": { recordAuditEvent: async () => { audits++; } },
      "@/lib/direct-deposit-admin": { getDirectDepositAudit: async () => null },
      "@/lib/direct-deposit": { getDirectDepositElection: async (_id: string, scope: { business: string }) => {
        assert.equal(scope.business, "Tiki"); decrypted++;
        return { id: "record", business: "Tiki", status: "Completed", payload: { accountNumber: "synthetic-sensitive-value" } };
      } },
    });
    const response = await route.GET({ nextUrl: new URL("https://test.invalid/api/direct-deposit?business=Tiki&id=record") });
    const privileged = role === "Owner" || role === "Co-Owner";
    assert.equal(response.status, privileged ? 200 : 403);
    assert.equal(decrypted, privileged ? 1 : 0);
    assert.equal(audits, privileged ? 1 : 0);
    if (privileged) assert.equal(response.headers.get("cache-control"), "private, no-store");
    else assert.doesNotMatch(await response.text(), /synthetic-sensitive-value/);
  });
}

test("production requires independent strong dedicated roots", () => {
  const env: Record<string, string> = { VERCEL_ENV: "production" };
  assert.equal(productionSecurityErrors(env).length, dedicatedProductionSecrets.length);
  for (const name of dedicatedProductionSecrets) env[name] = createHash("sha512").update(name).digest("base64");
  assert.deepEqual(productionSecurityErrors(env), []);
  env.EMPLOYEE_SESSION_SECRET = env.OWNER_SESSION_SECRET;
  assert.match(productionSecurityErrors(env).join(" "), /must not reuse/);
  env.VERCEL_ENV = "preview";
  assert.deepEqual(productionSecurityErrors(env), []);
});

test("production neither signs with fallback keys nor accepts legacy session signatures", () => {
  const old = { ...process.env };
  try {
    process.env.VERCEL_ENV = "production";
    process.env.SESSION_SECRET = createHash("sha512").update("old-root").digest("base64");
    delete process.env.OWNER_SESSION_SECRET;
    assert.throws(() => hmacSignature("data", "owner-session", { envName: "OWNER_SESSION_SECRET" }));
    assert.throws(() => purposeKey("no-explicit-root"));
    assert.throws(() => legacySessionHmac("data"), /disabled/);
  } finally { process.env = old; }
});

test("explicit historical application key preserves encrypted data after dedicated key rotation", () => {
  const old = { ...process.env };
  try {
    process.env.VERCEL_ENV = "preview";
    delete process.env.KEY_ENCRYPTION_KEY;
    const historical = createHash("sha512").update("former-forms-root").digest("base64");
    process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY = historical;
    const ciphertext = sealApplicationSecret("synthetic-vapid-key");
    process.env.VERCEL_ENV = "production";
    process.env.KEY_ENCRYPTION_KEY = createHash("sha512").update("new-key-root").digest("base64");
    process.env.LEGACY_KEY_ENCRYPTION_KEY = historical;
    assert.equal(openApplicationSecret(ciphertext), "synthetic-vapid-key");
    assert.notDeepEqual(purposeKey("application-key-encryption", { envName: "KEY_ENCRYPTION_KEY" }), historicalPurposeKey("application-key-encryption", historical));
  } finally { process.env = old; }
});

const command = { requestId: "11111111-1111-4111-8111-111111111111", action: "clock-out" as const,
  entryId: "22222222-2222-4222-8222-222222222222" };
test("old toggle commands and untargeted clock-outs are rejected", () => {
  assert.equal(parsePunchCommand({ latitude: 1, longitude: 1 }), null);
  assert.equal(parsePunchCommand({ ...command, entryId: null }), null);
  assert.deepEqual(parsePunchCommand(command), command);
});
test("a lost-response request is retained unchanged across reloads and scoped per employee", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  rememberPunch(store, "employee-one", command);
  assert.deepEqual(readPendingPunch(store, "employee-one"), command);
  assert.equal(readPendingPunch(store, "employee-two"), null);
  assert.throws(() => rememberPunch({ ...store, setItem: () => { throw new Error("Storage blocked"); } }, "employee-one", command), /Storage blocked/);
});
test("empty or mismatched success responses never confirm a punch", () => {
  assert.equal(isPunchReceipt({}, command), false);
  const receipt = { requestId: command.requestId, action: "clocked-out", employee: "Synthetic Employee",
    entry: { id: command.entryId, clock_in: "2026-09-01T10:00:00Z", clock_out: "2026-09-01T11:00:00Z", status: "Complete" } };
  assert.equal(isPunchReceipt(receipt, command), true);
  assert.equal(isPunchReceipt({ ...receipt, requestId: "other" }, command), false);
  assert.equal(isPunchReceipt({ ...receipt, action: "clocked-in" }, command), false);
});
test("missing GPS is not coerced into coordinates 0,0", () => {
  const result = locationReview({ latitude: null, longitude: null });
  assert.equal(result.latitude, null); assert.equal(result.longitude, null);
  assert.equal(result.needsReview, true); assert.equal(result.reason, "Location was not supplied.");
  assert.equal(locationReview({ latitude: 100, longitude: 1 }).latitude, null);
});

test("production integration decryption supports an explicit old root without weakening new encryption", () => {
  const old = { ...process.env };
  try {
    process.env.VERCEL_ENV = "preview";
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    const previous = createHash("sha512").update("previous-integration-root").digest("base64");
    process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY = previous;
    const keys = { purposeKey, historicalPurposeKey, legacySessionSecret: () => process.env.SESSION_SECRET };
    const encryption = loadSource("src/lib/integration-crypto.ts", { "@/lib/security-keys": keys });
    const encrypted = encryption.encryptIntegrationSecret("synthetic-provider-token");
    process.env.VERCEL_ENV = "production";
    process.env.INTEGRATION_ENCRYPTION_KEY = createHash("sha512").update("new-integration-root").digest("base64");
    process.env.LEGACY_INTEGRATION_ENCRYPTION_KEY = previous;
    assert.equal(encryption.decryptIntegrationSecret(encrypted), "synthetic-provider-token");
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    assert.throws(() => encryption.encryptIntegrationSecret("must-not-use-the-old-root"));
  } finally { process.env = old; }
});

test("time-clock transport failure reports uncertainty, not a claim that the write failed", async () => {
  const service = loadSource("src/lib/tiki-timeclock.ts", {
    "@/lib/db": { getSql: () => async () => { throw new Error("connection lost after commit"); } },
    "./timeclock-contract": { isPunchReceipt }, "./timeclock-location": { locationReview },
  });
  await assert.rejects(service.punchAuthenticatedTikiEmployee("employee", {}, command),
    (error: unknown) => (error as { code?: string }).code === "PUNCH_NOT_CONFIRMED");
});
