import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { getEmploymentFormProfile } from "@/lib/employment-forms";
import { cornerOpsBaseUrl, ownerNotificationEmails, sendTransactionalEmail } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";

export type DirectDepositStatus = "Assigned" | "Completed" | "Superseded";

export type DirectDepositSummary = {
  id: string;
  business: Business;
  employeeId: string;
  employeeName: string;
  status: DirectDepositStatus;
  assignedAt: string;
  signedAt: string | null;
};

export type DirectDepositDetail = DirectDepositSummary & {
  payload: Record<string, unknown>;
};

type ElectionRow = {
  id: string;
  business: Business;
  employee_id: string;
  employee_name: string;
  status: DirectDepositStatus;
  encrypted_payload: string;
  assigned_at: string | Date;
  signed_at: string | Date | null;
};

type EmployeeRow = {
  id: string;
  business: Business;
  name: string;
  position: string;
};

let schemaPromise: Promise<void> | null = null;

export function ensureDirectDepositSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS direct_deposit_elections (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id),
          employee_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Assigned', 'Completed', 'Superseded')),
          encrypted_payload TEXT NOT NULL,
          assigned_by TEXT NOT NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          employee_signature_name TEXT NOT NULL DEFAULT '',
          signed_at TIMESTAMPTZ,
          signature_ip TEXT NOT NULL DEFAULT '',
          signature_user_agent TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS direct_deposit_employee_idx ON direct_deposit_elections (employee_id, assigned_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS direct_deposit_business_status_idx ON direct_deposit_elections (business, status, assigned_at DESC)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function encryptionKey(): Buffer {
  const secret = process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error("EMPLOYMENT_FORMS_ENCRYPTION_KEY must be configured with at least 32 characters.");
  return createHash("sha256").update(secret, "utf8").digest();
}

function encrypt(payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

function decrypt(value: string): Record<string, unknown> {
  const [version, iv, tag, body] = value.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Direct-deposit record is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
  return JSON.parse(clear.toString("utf8")) as Record<string, unknown>;
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function summary(row: ElectionRow): DirectDepositSummary {
  return {
    id: row.id,
    business: row.business,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    status: row.status,
    assignedAt: iso(row.assigned_at)!,
    signedAt: iso(row.signed_at),
  };
}

async function employee(business: Business, employeeId: string): Promise<EmployeeRow> {
  const rows = await getSql()`
    SELECT id, business, name, position
    FROM employees
    WHERE business = ${business} AND id = ${employeeId} AND active = TRUE
    LIMIT 1
  ` as unknown as EmployeeRow[];
  if (!rows[0]) throw new Error("Employee was not found.");
  return rows[0];
}

function noticePayload(business: Business, person: EmployeeRow, employer: Record<string, unknown>) {
  return {
    formVersion: "NY LS 15 current edition · 2026-08",
    sourceUrl: "https://dol.ny.gov/LS15-doc",
    employer,
    employee: { id: person.id, name: person.name, position: person.position, business },
    paymentOptions: "Paper check or voluntary direct deposit to an account at a financial institution selected by the employee.",
    notice: "Direct deposit is voluntary and is not a condition of hire or continued employment. An employee who does not consent to direct deposit will be paid by paper check. The employer will not charge a fee required to access wages in full. The employee may select any financial institution, withdraw consent at any time, or request another payment method. A requested change will be completed within two full pay periods.",
    terms: "If direct deposit is selected, the employee authorizes ACH credits to the account supplied and an adjustment or reversal only when legally permitted and necessary to correct an erroneous deposit. The employee is responsible for accurate account information and for promptly notifying payroll of changes. Separate terms or fees imposed by the employee's financial institution may apply.",
    retention: "The employer will retain written direct-deposit consent during employment and for six years after the final wage payment made through direct deposit.",
  };
}

async function notifyOwner(input: {
  subject: string;
  lines: string[];
}): Promise<void> {
  const recipients = ownerNotificationEmails();
  if (!recipients.length) return;
  const base = cornerOpsBaseUrl();
  try {
    await sendTransactionalEmail({
      to: recipients,
      subject: input.subject,
      text: [
        ...input.lines,
        base ? `Review securely: ${base}/ops/direct-deposit` : "Open People > Direct deposit onboarding to review securely.",
        "",
        "Full routing and account numbers are intentionally excluded from email.",
      ].join("\n"),
    });
  } catch (error) {
    console.error("[direct-deposit] owner notification failed", error);
  }
}

export async function assignDirectDepositElection(input: {
  business: Business;
  employeeId: string;
  actor: string;
}): Promise<DirectDepositSummary> {
  await ensureDirectDepositSchema();
  const person = await employee(input.business, input.employeeId);
  const employer = await getEmploymentFormProfile(input.business);
  await getSql()`
    UPDATE direct_deposit_elections
    SET status = 'Superseded', updated_at = NOW()
    WHERE business = ${input.business} AND employee_id = ${input.employeeId} AND status = 'Assigned'
  `;
  const id = randomUUID();
  const rows = await getSql()`
    INSERT INTO direct_deposit_elections (
      id, business, employee_id, employee_name, status, encrypted_payload, assigned_by
    ) VALUES (
      ${id}, ${input.business}, ${person.id}, ${person.name}, 'Assigned',
      ${encrypt(noticePayload(input.business, person, employer as unknown as Record<string, unknown>))}, ${input.actor}
    )
    RETURNING id, business, employee_id, employee_name, status, encrypted_payload, assigned_at, signed_at
  ` as unknown as ElectionRow[];
  await notifyOwner({
    subject: `[Corner Ops] Payment-method form assigned: ${person.name}`,
    lines: [
      `${person.name} (${input.business}) was assigned a new direct-deposit or paper-check election.`,
      `Assigned by: ${input.actor}`,
      "No payroll change should be made until the employee signs and submits the election.",
      "",
    ],
  });
  return summary(rows[0]);
}

export async function ensureEmployeeDirectDepositElection(input: {
  business: Business;
  employeeId: string;
  actor?: string;
}): Promise<void> {
  await ensureDirectDepositSchema();
  const rows = await getSql()`
    SELECT id
    FROM direct_deposit_elections
    WHERE business = ${input.business} AND employee_id = ${input.employeeId}
      AND status IN ('Assigned', 'Completed')
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows.length) {
    await assignDirectDepositElection({ business: input.business, employeeId: input.employeeId, actor: input.actor || "Employee Hub onboarding" });
  }
}

export async function listDirectDepositEmployees(business: Business): Promise<Array<{ id: string; name: string; position: string }>> {
  await ensureDirectDepositSchema();
  const rows = await getSql()`
    SELECT id, name, position
    FROM employees
    WHERE business = ${business} AND active = TRUE
    ORDER BY name
  ` as unknown as Array<{ id: string; name: string; position: string }>;
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position }));
}

export async function listDirectDepositElections(business: Business, employeeId?: string): Promise<DirectDepositSummary[]> {
  await ensureDirectDepositSchema();
  const rows = employeeId
    ? await getSql()`
        SELECT id, business, employee_id, employee_name, status, encrypted_payload, assigned_at, signed_at
        FROM direct_deposit_elections
        WHERE business = ${business} AND employee_id = ${employeeId}
        ORDER BY assigned_at DESC
      ` as unknown as ElectionRow[]
    : await getSql()`
        SELECT id, business, employee_id, employee_name, status, encrypted_payload, assigned_at, signed_at
        FROM direct_deposit_elections
        WHERE business = ${business}
        ORDER BY assigned_at DESC
      ` as unknown as ElectionRow[];
  return rows.map(summary);
}

export async function getDirectDepositElection(id: string): Promise<DirectDepositDetail | null> {
  await ensureDirectDepositSchema();
  const rows = await getSql()`
    SELECT id, business, employee_id, employee_name, status, encrypted_payload, assigned_at, signed_at
    FROM direct_deposit_elections
    WHERE id = ${id}
    LIMIT 1
  ` as unknown as ElectionRow[];
  return rows[0] ? { ...summary(rows[0]), payload: decrypt(rows[0].encrypted_payload) } : null;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function lastFour(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? digits.slice(-4).padStart(4, "•") : "not provided";
}

export async function submitDirectDepositElection(input: {
  id: string;
  business: Business;
  employeeId: string;
  signatureName: string;
  payload: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
}): Promise<DirectDepositSummary> {
  await ensureDirectDepositSchema();
  const rows = await getSql()`
    SELECT id, business, employee_id, employee_name, status, encrypted_payload, assigned_at, signed_at
    FROM direct_deposit_elections
    WHERE id = ${input.id} AND business = ${input.business} AND employee_id = ${input.employeeId}
    LIMIT 1
  ` as unknown as ElectionRow[];
  const row = rows[0];
  if (!row) throw new Error("Direct-deposit form was not found.");
  if (row.status !== "Assigned") throw new Error("This direct-deposit election is already locked.");
  if (normalized(input.signatureName) !== normalized(row.employee_name)) {
    throw new Error(`Type the employee name exactly as ${row.employee_name} to sign.`);
  }
  const current = decrypt(row.encrypted_payload);
  const signed = {
    ...current,
    employeeSubmission: input.payload,
    employeeAttestation: {
      signatureName: input.signatureName.trim(),
      signedAt: new Date().toISOString(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      voluntaryElectionConfirmed: true,
    },
  };
  const updated = await getSql()`
    UPDATE direct_deposit_elections
    SET status = 'Completed', encrypted_payload = ${encrypt(signed)},
        employee_signature_name = ${input.signatureName.trim()}, signed_at = NOW(),
        signature_ip = ${input.ipAddress}, signature_user_agent = ${input.userAgent}, updated_at = NOW()
    WHERE id = ${row.id}
    RETURNING id, business, employee_id, employee_name, status, encrypted_payload, assigned_at, signed_at
  ` as unknown as ElectionRow[];

  const direct = input.payload.paymentChoice === "direct-deposit";
  await notifyOwner({
    subject: `[Corner Ops] Payroll payment change: ${row.employee_name}`,
    lines: direct ? [
      `${row.employee_name} (${input.business}) submitted a new DIRECT DEPOSIT election.`,
      `Financial institution: ${String(input.payload.financialInstitution || "Not provided")}`,
      `Account type: ${String(input.payload.accountType || "Not provided")}`,
      `Account ending: ${lastFour(input.payload.accountNumber)}`,
      "Action required: update the employee's payment method in payroll.",
      "",
    ] : [
      `${row.employee_name} (${input.business}) elected PAPER CHECK and declined or withdrew direct deposit.`,
      "Action required: update the employee's payment method in payroll.",
      "",
    ],
  });
  return summary(updated[0]);
}
