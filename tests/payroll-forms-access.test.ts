import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto, createCipheriv, createHash, randomBytes } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { DEFAULT_PUNCH_CORRECTION_REASON, normalizePunchCorrectionReason } from "../src/lib/punch-correction-reason";
import { canViewCompletedEmploymentForms, completedEmploymentSections, EMPLOYMENT_FORM_SENSITIVE_PERMISSION } from "../src/lib/employment-form-display";
import { redactEmploymentSensitiveData } from "../src/lib/sensitive-redaction";
import { requireStrongSecret } from "../src/lib/secret-strength";

const nativeRequire = createRequire(__filename);
const logs: unknown[][] = [];
function loadSource(path: string, mocks: Record<string, unknown>) {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Buffer, process, Response, Request, URL, crypto: webcrypto,
    console: { error: (...args: unknown[]) => logs.push(args), info: () => undefined },
    require: (name: string) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith("node:")) return nativeRequire(name);
      throw new Error(`Unmocked dependency: ${name}`);
    },
  }, { filename: path });
  return module.exports;
}
const http = loadSource("src/lib/http.ts", { "@/lib/config": { ConfigurationError: class extends Error {} } });
const users = loadSource("src/lib/users.ts", { "@/lib/db": {} });
const auth = loadSource("src/lib/auth.ts", {
  "next/headers": {}, "@/lib/db": {}, "@/lib/http": http, "@/lib/security-keys": {},
  "@/lib/types": { businesses: ["Tiki", "Corner Deli"] }, "@/lib/users": users,
});
const id = "11111111-1111-4111-8111-111111111111";
const employeeId = "22222222-2222-4222-8222-222222222222";
// An impossible SSN prefix is used so test fixtures cannot be mistaken for a person.
const syntheticSsn = "000-12-3456";
const completed = {
  id, employeeId, business: "Tiki", employeeName: "Synthetic Employee", formType: "W4", title: "W-4",
  status: "Completed", templateVersion: "2026", assignedAt: "2026-09-01T10:00:00Z",
  employeeSignedAt: "2026-09-02T10:00:00Z", employerSignedAt: null, effectiveDate: null, sourceUrl: "https://example.invalid/blank.pdf",
  payload: { employeeSubmission: { firstName: "Synthetic", ssn: syntheticSsn, filingStatus: "Single", extraWithholding: "0.00" },
    employeeAttestation: { signatureName: "Synthetic Employee", signedAt: "2026-09-02T10:00:00Z" } },
};
function identity(role: string, businesses = ["Tiki"]) {
  return { email: "owner@example.invalid", role, businesses, permissions: users.permissionsForRole(role) };
}
function completedRoute(session: ReturnType<typeof identity> | null, options: { auditFails?: boolean; form?: unknown } = {}) {
  const reads: unknown[] = []; const audits: unknown[] = [];
  const route = loadSource("src/app/api/employment-forms/completed/route.ts", {
    "@/lib/auth": { ...auth, getSession: async () => session },
    "@/lib/audit": { recordAuditEvent: async (entry: unknown) => {
      if (options.auditFails) throw new Error(`provider error contains ${syntheticSsn}`);
      audits.push(entry);
    } },
    "@/lib/employment-forms": { getEmploymentForm: async (formId: string, scope: unknown) => {
      reads.push({ formId, scope }); return Object.hasOwn(options, "form") ? options.form : completed;
    } },
    "@/lib/employment-form-display": { EMPLOYMENT_FORM_SENSITIVE_PERMISSION }, "@/lib/http": http,
  });
  return { route, reads, audits };
}
function request(body: unknown = { id, business: "Tiki" }, origin = "https://ops.example.invalid") {
  return new Request("https://ops.example.invalid/api/employment-forms/completed", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
  });
}
for (const role of ["Owner", "Co-Owner", "Manager", "Viewer", "Accountant"]) {
  test(`${role} completed form permission is enforced before decrypting any record`, async () => {
    const { route, reads, audits } = completedRoute(identity(role));
    const response = await route.POST(request());
    const allowed = role === "Owner" || role === "Co-Owner";
    assert.equal(response.status, allowed ? 200 : 403);
    assert.equal(reads.length, allowed ? 1 : 0);
    assert.equal(audits.length, allowed ? 1 : 0);
    assert.equal(canViewCompletedEmploymentForms(users.permissionsForRole(role)), allowed);
    const body = await response.text();
    assert.equal(body.includes(syntheticSsn), allowed);
    assert.match(response.headers.get("cache-control") || "", /private, no-store/);
    if (allowed) {
      assert.deepEqual(JSON.parse(JSON.stringify(reads[0])), { formId: id, scope: { business: "Tiki" } });
      assert.doesNotMatch(JSON.stringify(audits), /000-12-3456|extraWithholding|filingStatus/);
    }
  });
}
test("unsigned-in and employee-only sessions do not gain owner form access", async () => {
  const { route, reads } = completedRoute(null);
  const response = await route.POST(request({ id, business: "Tiki", role: "Owner", permissions: ["*"] }));
  assert.equal(response.status, 401); assert.equal(reads.length, 0);
});
test("cross-business access is rejected before record lookup", async () => {
  const { route, reads } = completedRoute(identity("Owner", ["Corner Deli"]));
  assert.equal((await route.POST(request())).status, 403); assert.equal(reads.length, 0);
});
test("a wrong-business row cannot be returned even by a misbehaving data layer", async () => {
  const { route, audits } = completedRoute(identity("Owner"), { form: { ...completed, business: "Corner Deli" } });
  const response = await route.POST(request());
  assert.equal(response.status, 404); assert.equal(audits.length, 0);
  assert.doesNotMatch(await response.text(), /000-12-3456/);
});
test("cross-origin form-view requests are rejected", async () => {
  const { route, reads } = completedRoute(identity("Owner"));
  assert.equal((await route.POST(request(undefined, "https://other.example.invalid"))).status, 403);
  assert.equal(reads.length, 0);
});
test("unsigned forms return an honest not-yet-submitted response", async () => {
  const { route, audits } = completedRoute(identity("Owner"), { form: { ...completed, status: "Assigned", employeeSignedAt: null } });
  assert.equal((await route.POST(request())).status, 409); assert.equal(audits.length, 0);
});
test("signed I-9 Section 1 can be viewed while employer review is pending", async () => {
  const { route } = completedRoute(identity("Owner"), { form: { ...completed, formType: "I9", status: "Employer Review" } });
  assert.equal((await route.POST(request())).status, 200);
});
test("audit write failure fails closed without including sensitive values in logs or errors", async () => {
  logs.length = 0;
  const { route } = completedRoute(identity("Owner"), { auditFails: true });
  const response = await route.POST(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /000-12-3456/);
  assert.doesNotMatch(JSON.stringify(logs), /000-12-3456/);
});
test("ordinary administrator review remains redacted", async () => {
  const route = loadSource("src/app/api/employment-forms/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/auth": { ...auth, getSession: async () => identity("Owner") },
    "@/lib/db": { getSql: () => async () => [] },
    "@/lib/employment-forms": { getEmploymentForm: async () => completed, ensureEmploymentFormsSchema: async () => undefined },
    "@/lib/sensitive-redaction": { redactEmploymentSensitiveData }, "@/lib/i9-validation": {},
  });
  const response = await route.GET({ nextUrl: new URL(`https://ops.example.invalid/api/employment-forms?business=Tiki&id=${id}`) });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /000-12-3456/);
});
test("Employee Hub still withholds completed tax and identity answers", async () => {
  const route = loadSource("src/app/api/employee/forms/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/employee-auth": { getEmployeeSession: async () => ({ business: "Tiki", employeeId }) },
    "@/lib/employment-forms": { getEmploymentForm: async () => completed }, "@/lib/i9-validation": {},
  });
  const response = await route.GET({ nextUrl: new URL(`https://ops.example.invalid/api/employee/forms?id=${id}`) });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /000-12-3456/);
});
test("scoped employment reader decrypts the original saved answers without changing leading zeros", async () => {
  const oldKey = process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY;
  try {
    process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY = createHash("sha512").update("synthetic-encryption-key").digest("base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY).digest(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(completed.payload)), cipher.final()]);
    const row = { id, business: "Tiki", employee_id: employeeId, employee_name: completed.employeeName, form_type: "W4", status: "Completed",
      employee_signed_at: completed.employeeSignedAt, assigned_at: completed.assignedAt,
      encrypted_payload: `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}` };
    const library = loadSource("src/lib/employment-forms.ts", {
      "@/lib/secret-strength": { requireStrongSecret },
      "@/lib/db": { ensureSchema: async () => undefined, getSql: () => async (sql: TemplateStringsArray, ...params: unknown[]) => {
        assert.match(sql.join("?"), /WHERE id = \? AND business = \?/);
        assert.match(sql.join("?"), /employee_id = \?::uuid/);
        assert.deepEqual(params, [id, "Tiki", employeeId, employeeId]);
        return [row];
      } },
    });
    const result = await library.getEmploymentForm(id, { business: "Tiki", employeeId });
    assert.equal(result.payload.employeeSubmission.ssn, syntheticSsn);
    assert.equal(result.payload.employeeSubmission.extraWithholding, "0.00");
  } finally {
    if (oldKey === undefined) delete process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY;
    else process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY = oldKey;
  }
});
test("completed view includes nested answers, employer sections, signatures, booleans, and zero values", () => {
  const sections = completedEmploymentSections({ ...completed.payload,
    employeeSubmission: { ...completed.payload.employeeSubmission, attest: false, dependents: 0, address: { zip: "00001" } },
    employerReview: { listANumber: "SYNTHETIC-ONLY" }, employerAttestation: { signatureName: "Employer", signedAt: "2026-09-02" },
  });
  const answers = sections.find((section) => section.key === "employeeSubmission")!.fields;
  assert.equal(answers.find((field) => field.key === "ssn")?.value, syntheticSsn);
  assert.equal(answers.find((field) => field.key === "ssn")?.label, "Social Security number (SSN)");
  assert.equal(answers.find((field) => field.key === "attest")?.value, "No");
  assert.equal(answers.find((field) => field.key === "dependents")?.value, "0");
  assert.equal(answers.find((field) => field.key === "address.zip")?.value, "00001");
  assert.ok(sections.some((section) => section.key === "employerReview"));
  assert.ok(sections.some((section) => section.key === "employeeAttestation"));
  assert.ok(sections.some((section) => section.key === "employerAttestation"));
});
for (const reason of [undefined, null, "", "   ", "x", "Forgot to clock out"]) {
  test(`punch correction accepts ${JSON.stringify(reason)} and still writes a reason and actor to the audit`, async () => {
    const expected = typeof reason === "string" && reason.trim() ? reason : DEFAULT_PUNCH_CORRECTION_REASON;
    assert.equal(normalizePunchCorrectionReason(reason), expected);
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const before = { id, employee_id: employeeId, employee_name: "Synthetic Employee", position: "Bartender", clock_in: "2026-09-01T10:00:00Z", clock_out: null };
    const after = { ...before, clock_out: "2026-09-01T11:00:00Z", status: "Corrected" };
    const library = loadSource("src/lib/payroll-punch-correction.ts", {
      "./punch-correction-reason": { normalizePunchCorrectionReason },
      "@/lib/db": { ensureSchema: async () => undefined, getSql: () => async (parts: TemplateStringsArray, ...params: unknown[]) => {
        const sql = parts.join("?"); queries.push({ sql, params });
        return sql.includes("UPDATE time_entries") ? [after] : sql.includes("SELECT * FROM time_entries") ? [before] : [];
      } },
    });
    const result = await library.correctPunch({ business: "Tiki", sourceType: "Tiki", sourceId: id,
      clockIn: before.clock_in, clockOut: after.clock_out, reason, actor: "owner@example.invalid" });
    assert.equal(result.corrected, true);
    const audit = queries.find((query) => query.sql.includes("INSERT INTO time_entry_adjustments"))!;
    assert.ok(audit.params.includes(expected)); assert.ok(audit.params.includes("owner@example.invalid"));
  });
}
test("Tiki HTTP correction saves without a supplied reason", async () => {
  const audits: unknown[][] = [];
  let saved = false;
  const row = { id, employee_id: employeeId, employee_name: "Synthetic Employee", position: "Bartender", clock_in: "2026-09-01T14:00:00Z", clock_out: "2026-09-01T15:00:00Z", status: "Corrected" };
  const route = loadSource("src/app/api/tiki-time-corrections/route.ts", {
    "@/lib/auth": { ...auth, getSession: async () => identity("Owner") }, "@/lib/http": http,
    "@/lib/payroll-week": {}, "@/lib/punch-correction-reason": { normalizePunchCorrectionReason },
    "@/lib/db": { getSql: () => async (parts: TemplateStringsArray, ...params: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes("INSERT INTO time_entry_adjustments")) { audits.push(params); return []; }
      if (sql.includes("UPDATE time_entries")) { saved = true; assert.ok(params.includes("Correction: Owner time correction")); return [row]; }
      if (sql.includes("AND id <>")) return [];
      return [{ ...row, clock_out: saved ? row.clock_out : null }];
    } },
  });
  const response = await route.POST(new Request("https://ops.example.invalid/api/tiki-time-corrections", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "correct", sourceId: id,
      clockInWall: "2026-09-01T10:00", clockOutWall: "2026-09-01T11:00" }),
  }));
  assert.equal(response.status, 200); assert.equal((await response.json()).corrected, true);
  assert.ok(audits[0].includes(DEFAULT_PUNCH_CORRECTION_REASON));
});
test("legacy correction entry point delegates instead of reintroducing a required reason", () => {
  const source = readFileSync("src/lib/payroll-control.ts", "utf8");
  assert.match(source, /export \{ correctPunch \} from "\.\/payroll-punch-correction"/);
  assert.doesNotMatch(source, /A correction reason is required/);
});
