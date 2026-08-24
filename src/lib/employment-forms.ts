import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { requireStrongSecret } from "@/lib/secret-strength";
import type { Business } from "@/lib/types";

export type EmploymentFormType = "W4" | "IT2104" | "I9" | "PAY_NOTICE" | "MEAL_POLICY";
export type EmploymentFormStatus = "Assigned" | "Employee Signed" | "Employer Review" | "Completed" | "Superseded";

export type EmploymentFormSummary = {
  id: string;
  business: Business;
  employeeId: string;
  employeeName: string;
  formType: EmploymentFormType;
  title: string;
  templateVersion: string;
  status: EmploymentFormStatus;
  effectiveDate: string | null;
  assignedAt: string;
  employeeSignedAt: string | null;
  employerSignedAt: string | null;
  sourceUrl: string;
};

export type EmploymentFormDetail = EmploymentFormSummary & {
  payload: Record<string, unknown>;
};

export type EmploymentFormProfile = {
  legalName: string;
  dba: string;
  ein: string;
  address: string;
  phone: string;
  payFrequency: string;
  payday: string;
  dependentHealthAvailable: boolean;
  dependentHealthEligibility: string;
};

type FormRow = {
  id: string;
  business: Business;
  employee_id: string;
  employee_name: string;
  form_type: EmploymentFormType;
  title: string;
  template_version: string;
  status: EmploymentFormStatus;
  effective_date: string | Date | null;
  assigned_at: string | Date;
  employee_signed_at: string | Date | null;
  employer_signed_at: string | Date | null;
  source_url: string;
  encrypted_payload: string;
};

type EmployeeRow = {
  id: string;
  business: Business;
  name: string;
  position: string;
  hourly_rate: string | number;
  tipped_rate: string | number;
};

const templates: Record<EmploymentFormType, { title: string; version: string; sourceUrl: string }> = {
  W4: {
    title: "Federal Form W-4, Employee's Withholding Certificate",
    version: "2026",
    sourceUrl: "https://www.irs.gov/pub/irs-pdf/fw4.pdf",
  },
  IT2104: {
    title: "New York Form IT-2104, Employee's Withholding Allowance Certificate",
    version: "2026",
    sourceUrl: "https://www.tax.ny.gov/pdf/current_forms/it/it2104_fill_in.pdf",
  },
  I9: {
    title: "Form I-9, Employment Eligibility Verification",
    version: "08/01/23 · expires 05/31/2027",
    sourceUrl: "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf",
  },
  PAY_NOTICE: {
    title: "New York Notice and Acknowledgment of Pay Rate and Payday",
    version: "LS 54 / LS 55 current edition",
    sourceUrl: "https://dol.ny.gov/notice-pay-rate",
  },
  MEAL_POLICY: {
    title: "New York Meal Period Policy Acknowledgment",
    version: "2026-08",
    sourceUrl: "https://dol.ny.gov/day-rest-and-meal-periods",
  },
};

let employmentSchemaPromise: Promise<void> | null = null;

export function ensureEmploymentFormsSchema(): Promise<void> {
  if (!employmentSchemaPromise) {
    employmentSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS employment_form_profiles (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
          profile JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS employment_forms (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id),
          employee_name TEXT NOT NULL,
          form_type TEXT NOT NULL CHECK (form_type IN ('W4', 'IT2104', 'I9', 'PAY_NOTICE', 'MEAL_POLICY')),
          title TEXT NOT NULL,
          template_version TEXT NOT NULL,
          source_url TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Assigned', 'Employee Signed', 'Employer Review', 'Completed', 'Superseded')),
          effective_date DATE,
          encrypted_payload TEXT NOT NULL,
          assigned_by TEXT NOT NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          employee_signature_name TEXT NOT NULL DEFAULT '',
          employee_signed_at TIMESTAMPTZ,
          employer_signature_name TEXT NOT NULL DEFAULT '',
          employer_signed_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employment_forms_employee_idx ON employment_forms (employee_id, assigned_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS employment_forms_business_status_idx ON employment_forms (business, status, assigned_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS employment_form_events (
          id UUID PRIMARY KEY,
          form_id UUID NOT NULL REFERENCES employment_forms(id) ON DELETE CASCADE,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employment_form_events_form_idx ON employment_form_events (form_id, created_at)`;
    })().catch((error) => {
      employmentSchemaPromise = null;
      throw error;
    });
  }
  return employmentSchemaPromise;
}

function encryptionKey(): Buffer {
  const secret = requireStrongSecret(process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY, "EMPLOYMENT_FORMS_ENCRYPTION_KEY");
  return createHash("sha256").update(secret, "utf8").digest();
}

function encryptPayload(payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptPayload(value: string): Record<string, unknown> {
  const [version, ivValue, tagValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Employment form payload is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;
}

function isoDate(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function isoDateTime(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function summary(row: FormRow): EmploymentFormSummary {
  return {
    id: row.id,
    business: row.business,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    formType: row.form_type,
    title: row.title,
    templateVersion: row.template_version,
    status: row.status,
    effectiveDate: isoDate(row.effective_date),
    assignedAt: isoDateTime(row.assigned_at)!,
    employeeSignedAt: isoDateTime(row.employee_signed_at),
    employerSignedAt: isoDateTime(row.employer_signed_at),
    sourceUrl: row.source_url,
  };
}

async function event(formId: string, action: string, actor: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await getSql()`
    INSERT INTO employment_form_events (id, form_id, action, actor, metadata)
    VALUES (${randomUUID()}, ${formId}, ${action}, ${actor}, ${JSON.stringify(metadata)}::jsonb)
  `;
}

export async function getEmploymentFormProfile(business: Business): Promise<EmploymentFormProfile> {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`SELECT profile FROM employment_form_profiles WHERE business = ${business} LIMIT 1` as unknown as Array<{ profile: Partial<EmploymentFormProfile> }>;
  const profile = rows[0]?.profile || {};
  return {
    legalName: String(profile.legalName || ""),
    dba: String(profile.dba || business),
    ein: String(profile.ein || ""),
    address: String(profile.address || ""),
    phone: String(profile.phone || ""),
    payFrequency: String(profile.payFrequency || "Weekly"),
    payday: String(profile.payday || ""),
    dependentHealthAvailable: Boolean(profile.dependentHealthAvailable),
    dependentHealthEligibility: String(profile.dependentHealthEligibility || ""),
  };
}

export async function saveEmploymentFormProfile(business: Business, profile: EmploymentFormProfile, actor: string): Promise<EmploymentFormProfile> {
  await ensureEmploymentFormsSchema();
  await getSql()`
    INSERT INTO employment_form_profiles (business, profile, updated_by)
    VALUES (${business}, ${JSON.stringify(profile)}::jsonb, ${actor})
    ON CONFLICT (business) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
  return getEmploymentFormProfile(business);
}

export async function listEmploymentEmployees(business: Business): Promise<Array<{ id: string; name: string; position: string; hourlyRate: number; tippedRate: number }>> {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`
    SELECT id, business, name, position, hourly_rate, tipped_rate
    FROM employees
    WHERE business = ${business} AND active = TRUE
    ORDER BY name
  ` as unknown as EmployeeRow[];
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position, hourlyRate: Number(row.hourly_rate), tippedRate: Number(row.tipped_rate) }));
}

async function findEmployee(business: Business, employeeId: string): Promise<EmployeeRow> {
  const rows = await getSql()`
    SELECT id, business, name, position, hourly_rate, tipped_rate
    FROM employees
    WHERE business = ${business} AND id = ${employeeId}
    LIMIT 1
  ` as unknown as EmployeeRow[];
  if (!rows[0]) throw new Error("Employee was not found.");
  return rows[0];
}

async function insertForm(input: {
  business: Business;
  employee: EmployeeRow;
  type: EmploymentFormType;
  actor: string;
  effectiveDate?: string | null;
  employerSignature?: string;
  payload: Record<string, unknown>;
}): Promise<EmploymentFormSummary> {
  const id = randomUUID();
  const template = templates[input.type];
  const employerSigned = input.employerSignature?.trim() || "";
  const rows = await getSql()`
    INSERT INTO employment_forms (
      id, business, employee_id, employee_name, form_type, title, template_version,
      source_url, status, effective_date, encrypted_payload, assigned_by,
      employer_signature_name, employer_signed_at
    ) VALUES (
      ${id}, ${input.business}, ${input.employee.id}, ${input.employee.name}, ${input.type},
      ${template.title}, ${template.version}, ${template.sourceUrl}, 'Assigned',
      ${input.effectiveDate || null}, ${encryptPayload(input.payload)}, ${input.actor},
      ${employerSigned}, ${employerSigned ? new Date().toISOString() : null}
    )
    RETURNING *
  ` as unknown as FormRow[];
  await event(id, "assigned", input.actor, { templateVersion: template.version, effectiveDate: input.effectiveDate || null });
  return summary(rows[0]);
}

export async function assignOnboardingPacket(input: {
  business: Business;
  employeeId: string;
  hireDate: string;
  actor: string;
  employerSignature: string;
}): Promise<EmploymentFormSummary[]> {
  await ensureEmploymentFormsSchema();
  const employee = await findEmployee(input.business, input.employeeId);
  const profile = await getEmploymentFormProfile(input.business);
  if (!profile.legalName || !profile.ein || !profile.address || !profile.phone || !profile.payday) {
    throw new Error("Complete the employer form profile before assigning an onboarding packet.");
  }
  if (!input.employerSignature.trim()) throw new Error("Employer signature is required before assigning the packet.");
  const hourlyRate = Number(employee.hourly_rate);
  const tippedRate = Number(employee.tipped_rate);
  const multipleRates = tippedRate > 0 && Math.abs(tippedRate - hourlyRate) > 0.005;
  const common = {
    employer: profile,
    employee: { id: employee.id, name: employee.name, position: employee.position, hourlyRate, tippedRate },
    hireDate: input.hireDate,
  };
  const mealPolicy = {
    statement: "Employees who work a shift requiring a meal period will receive an uninterrupted unpaid meal period of at least 30 minutes, or longer when required by law. Meal periods are scheduled around operational needs and applicable New York law. Employees must be completely relieved of duty. Any interrupted meal period or work performed during a meal period must be reported immediately so all working time is recorded and paid. This acknowledgment does not waive any legal meal-period right.",
  };
  return Promise.all([
    insertForm({ business: input.business, employee, type: "W4", actor: input.actor, effectiveDate: input.hireDate, payload: { ...common } }),
    insertForm({ business: input.business, employee, type: "IT2104", actor: input.actor, effectiveDate: input.hireDate, payload: { ...common } }),
    insertForm({ business: input.business, employee, type: "I9", actor: input.actor, effectiveDate: input.hireDate, payload: { ...common } }),
    insertForm({
      business: input.business,
      employee,
      type: "PAY_NOTICE",
      actor: input.actor,
      effectiveDate: input.hireDate,
      employerSignature: input.employerSignature,
      payload: {
        ...common,
        noticeKind: "new-hire",
        formVariant: multipleRates ? "LS55" : "LS54",
        regularRate: hourlyRate,
        secondaryRate: multipleRates ? tippedRate : null,
        overtimeRate: hourlyRate * 1.5,
        tipCreditOrAllowance: multipleRates ? Math.max(0, hourlyRate - tippedRate) : 0,
      },
    }),
    insertForm({ business: input.business, employee, type: "MEAL_POLICY", actor: input.actor, effectiveDate: input.hireDate, employerSignature: input.employerSignature, payload: { ...common, ...mealPolicy } }),
  ]);
}

export async function assignRateChange(input: {
  business: Business;
  employeeId: string;
  effectiveDate: string;
  hourlyRate: number;
  tippedRate: number;
  actor: string;
  employerSignature: string;
}): Promise<EmploymentFormSummary> {
  await ensureEmploymentFormsSchema();
  const employee = await findEmployee(input.business, input.employeeId);
  const profile = await getEmploymentFormProfile(input.business);
  if (!input.employerSignature.trim()) throw new Error("Employer signature is required.");
  if (!Number.isFinite(input.hourlyRate) || input.hourlyRate <= 0) throw new Error("Enter a valid hourly rate.");
  const multipleRates = input.tippedRate > 0 && Math.abs(input.tippedRate - input.hourlyRate) > 0.005;
  return insertForm({
    business: input.business,
    employee,
    type: "PAY_NOTICE",
    actor: input.actor,
    effectiveDate: input.effectiveDate,
    employerSignature: input.employerSignature,
    payload: {
      employer: profile,
      employee: { id: employee.id, name: employee.name, position: employee.position },
      noticeKind: "rate-change",
      formVariant: multipleRates ? "LS55" : "LS54",
      regularRate: input.hourlyRate,
      secondaryRate: multipleRates ? input.tippedRate : null,
      overtimeRate: input.hourlyRate * 1.5,
      tipCreditOrAllowance: multipleRates ? Math.max(0, input.hourlyRate - input.tippedRate) : 0,
      effectiveDate: input.effectiveDate,
    },
  });
}

export async function listEmploymentForms(business: Business, employeeId?: string): Promise<EmploymentFormSummary[]> {
  await ensureEmploymentFormsSchema();
  const rows = employeeId
    ? await getSql()`SELECT * FROM employment_forms WHERE business = ${business} AND employee_id = ${employeeId} ORDER BY assigned_at DESC` as unknown as FormRow[]
    : await getSql()`SELECT * FROM employment_forms WHERE business = ${business} ORDER BY assigned_at DESC` as unknown as FormRow[];
  return rows.map(summary);
}

export async function getEmploymentForm(id: string): Promise<EmploymentFormDetail | null> {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`SELECT * FROM employment_forms WHERE id = ${id} LIMIT 1` as unknown as FormRow[];
  return rows[0] ? { ...summary(rows[0]), payload: decryptPayload(rows[0].encrypted_payload) } : null;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export async function submitEmployeeEmploymentForm(input: {
  id: string;
  employeeId: string;
  business: Business;
  signatureName: string;
  payload: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
}): Promise<EmploymentFormSummary> {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`
    SELECT * FROM employment_forms
    WHERE id = ${input.id} AND employee_id = ${input.employeeId} AND business = ${input.business}
    LIMIT 1
  ` as unknown as FormRow[];
  const row = rows[0];
  if (!row) throw new Error("Employment form was not found.");
  if (row.status !== "Assigned") throw new Error("This form has already been submitted and is locked.");
  if (normalizedName(input.signatureName) !== normalizedName(row.employee_name)) {
    throw new Error(`Type the employee name exactly as ${row.employee_name} to sign.`);
  }
  const current = decryptPayload(row.encrypted_payload);
  const signedPayload = {
    ...current,
    employeeSubmission: input.payload,
    employeeAttestation: {
      signatureName: input.signatureName.trim(),
      signedAt: new Date().toISOString(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      finalEntryConfirmed: true,
    },
  };
  const nextStatus: EmploymentFormStatus = row.form_type === "I9" ? "Employer Review" : "Completed";
  const updated = await getSql()`
    UPDATE employment_forms
    SET encrypted_payload = ${encryptPayload(signedPayload)}, status = ${nextStatus},
        employee_signature_name = ${input.signatureName.trim()}, employee_signed_at = NOW(), updated_at = NOW()
    WHERE id = ${row.id}
    RETURNING *
  ` as unknown as FormRow[];
  await event(row.id, "employee-signed", row.employee_name, { ipAddress: input.ipAddress, userAgent: input.userAgent, status: nextStatus });
  return summary(updated[0]);
}

export async function completeEmployerI9(input: {
  id: string;
  business: Business;
  actor: string;
  signatureName: string;
  payload: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
}): Promise<EmploymentFormSummary> {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`SELECT * FROM employment_forms WHERE id = ${input.id} AND business = ${input.business} LIMIT 1` as unknown as FormRow[];
  const row = rows[0];
  if (!row || row.form_type !== "I9") throw new Error("I-9 form was not found.");
  if (row.status !== "Employer Review") throw new Error("The employee must sign Section 1 before employer review.");
  if (!input.signatureName.trim()) throw new Error("Employer signature is required.");
  const current = decryptPayload(row.encrypted_payload);
  const completedPayload = {
    ...current,
    employerReview: input.payload,
    employerAttestation: {
      signatureName: input.signatureName.trim(),
      signedAt: new Date().toISOString(),
      actor: input.actor,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  };
  const updated = await getSql()`
    UPDATE employment_forms
    SET encrypted_payload = ${encryptPayload(completedPayload)}, status = 'Completed',
        employer_signature_name = ${input.signatureName.trim()}, employer_signed_at = NOW(), updated_at = NOW()
    WHERE id = ${row.id}
    RETURNING *
  ` as unknown as FormRow[];
  await event(row.id, "employer-completed-i9", input.actor, { ipAddress: input.ipAddress, userAgent: input.userAgent });
  return summary(updated[0]);
}
