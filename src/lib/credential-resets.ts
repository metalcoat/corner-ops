import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { assertEmployeePinAvailable, createEmployeePinRecord, isEmployeePinUniqueViolation } from "@/lib/employee-pin-security";
import { employeePinLabel } from "@/lib/employee-pin";
import { cornerOpsBaseUrl, sendTransactionalEmail } from "@/lib/transactional-email";
import { ensureUserSchema } from "@/lib/users";
import type { Business } from "@/lib/types";

const RESET_MINUTES = 30;
type ResetKind = "app-password" | "employee-pin";

type ResetRow = {
  id: string;
  kind: ResetKind;
  subject_id: string;
  business: Business | null;
  email: string;
  token_hash: string;
  expires_at: string | Date;
  used_at: string | Date | null;
};

let resetSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalizedEmail(value: unknown): string {
  return clean(value, 320).toLowerCase();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function passwordRecord(password: string): { salt: string; hash: string } {
  if (password.length < 10) throw new Error("Passwords must contain at least 10 characters.");
  const salt = randomBytes(18).toString("base64url");
  return { salt, hash: scryptSync(password, salt, 64).toString("base64url") };
}


export function ensureCredentialResetSchema(): Promise<void> {
  if (!resetSchemaPromise) {
    resetSchemaPromise = (async () => {
      await ensureSchema();
      await getSql()`
        CREATE TABLE IF NOT EXISTS credential_reset_tokens (
          id UUID PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('app-password', 'employee-pin')),
          subject_id UUID NOT NULL,
          business TEXT CHECK (business IS NULL OR business IN ('Corner Deli', 'Tiki')),
          email TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          requested_ip TEXT NOT NULL DEFAULT '',
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await getSql()`CREATE INDEX IF NOT EXISTS credential_reset_active_idx ON credential_reset_tokens (kind, email, expires_at DESC) WHERE used_at IS NULL`;
    })().catch((error) => {
      resetSchemaPromise = null;
      throw error;
    });
  }
  return resetSchemaPromise;
}

async function issueToken(input: {
  kind: ResetKind;
  subjectId: string;
  business?: Business | null;
  email: string;
  requestedIp: string;
}): Promise<string> {
  await ensureCredentialResetSchema();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
  const sql = getSql();
  await sql`
    UPDATE credential_reset_tokens
    SET used_at = NOW()
    WHERE kind = ${input.kind} AND subject_id = ${input.subjectId} AND used_at IS NULL
  `;
  await sql`
    INSERT INTO credential_reset_tokens (
      id, kind, subject_id, business, email, token_hash, requested_ip, expires_at
    ) VALUES (
      ${randomUUID()}, ${input.kind}, ${input.subjectId}, ${input.business || null},
      ${input.email}, ${tokenHash(token)}, ${clean(input.requestedIp, 120)}, ${expiresAt}
    )
  `;
  return token;
}

async function activeReset(kind: ResetKind, token: string): Promise<ResetRow> {
  await ensureCredentialResetSchema();
  const rows = await getSql()`
    SELECT id, kind, subject_id, business, email, token_hash, expires_at, used_at
    FROM credential_reset_tokens
    WHERE kind = ${kind} AND token_hash = ${tokenHash(token)}
      AND used_at IS NULL AND expires_at > NOW()
    LIMIT 1
  ` as unknown as ResetRow[];
  if (!rows[0]) throw new Error("This reset link is invalid or has expired.");
  return rows[0];
}

export async function requestAppPasswordReset(input: {
  email: string;
  requestedIp: string;
}): Promise<void> {
  await ensureUserSchema();
  const email = normalizedEmail(input.email);
  const rows = await getSql()`
    SELECT id, email, display_name
    FROM app_users
    WHERE email = ${email} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string; email: string; display_name: string }>;
  const user = rows[0];
  if (!user) return;

  const token = await issueToken({ kind: "app-password", subjectId: user.id, email: user.email, requestedIp: input.requestedIp });
  const base = cornerOpsBaseUrl();
  if (!base) throw new Error("APP_URL must be configured before password reset email can be sent.");
  const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
  await sendTransactionalEmail({
    to: user.email,
    subject: "Reset your Corner Ops password",
    text: [
      `Hi ${clean(user.display_name, 120).split(/\s+/)[0] || "there"},`,
      "",
      "A password reset was requested for your Corner Ops account.",
      "",
      `Reset your password within ${RESET_MINUTES} minutes:`,
      link,
      "",
      "If you did not request this, you can ignore this email. The link can be used only once.",
    ].join("\n"),
  });
}

export async function completeAppPasswordReset(input: { token: string; password: string }): Promise<void> {
  const reset = await activeReset("app-password", clean(input.token, 500));
  const password = passwordRecord(String(input.password || ""));
  const sql = getSql();
  const updated = await sql`
    UPDATE app_users
    SET password_salt = ${password.salt}, password_hash = ${password.hash},
        legacy_owner = FALSE, session_version = session_version + 1, updated_at = NOW()
    WHERE id = ${reset.subject_id} AND active = TRUE
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!updated[0]) throw new Error("This account is no longer active.");
  await sql`UPDATE credential_reset_tokens SET used_at = NOW() WHERE id = ${reset.id}`;
}

export async function requestEmployeePinReset(input: {
  email: string;
  business: Business;
  requestedIp: string;
}): Promise<void> {
  await ensureEmployeeDirectorySchema();
  const email = normalizedEmail(input.email);
  const rows = await getSql()`
    SELECT id, email, name, business
    FROM employees
    WHERE business = ${input.business} AND LOWER(email) = ${email} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string; email: string; name: string; business: Business }>;
  const employee = rows[0];
  if (!employee) return;

  const token = await issueToken({
    kind: "employee-pin",
    subjectId: employee.id,
    business: employee.business,
    email: employee.email,
    requestedIp: input.requestedIp,
  });
  const base = cornerOpsBaseUrl();
  if (!base) throw new Error("APP_URL must be configured before PIN reset email can be sent.");
  const link = `${base}/employee/reset-pin?token=${encodeURIComponent(token)}`;
  await sendTransactionalEmail({
    to: employee.email,
    subject: `Reset your ${employee.business} Employee Hub PIN`,
    text: [
      `Hi ${clean(employee.name, 120).split(/\s+/)[0] || "there"},`,
      "",
      `A ${employeePinLabel(employee.business).toLowerCase()} reset was requested for ${employee.business}.`,
      "",
      `Choose a new PIN within ${RESET_MINUTES} minutes:`,
      link,
      "",
      "If you did not request this, you can ignore this email. The link can be used only once.",
    ].join("\n"),
  });
}

export async function completeEmployeePinReset(input: { token: string; pin: string }): Promise<void> {
  const reset = await activeReset("employee-pin", clean(input.token, 500));
  if (!reset.business) throw new Error("The employee reset record is incomplete.");
  const pin = await assertEmployeePinAvailable({ business: reset.business, pin: input.pin, employeeName: "Employee", excludeEmployeeId: reset.subject_id });
  const record = createEmployeePinRecord(reset.business, pin, "Employee");
  const sql = getSql();
  try {
    const updated = await sql`
      UPDATE employees
      SET pin_hash = ${record.hash}, pin_salt = ${record.salt}, pin_hash_version = ${record.version},
          pin_fingerprint = ${record.fingerprint}, pin_enabled = TRUE,
          session_version = session_version + 1, updated_at = NOW()
      WHERE id = ${reset.subject_id} AND business = ${reset.business} AND active = TRUE
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    if (!updated[0]) throw new Error("This employee account is no longer active.");
  } catch (error) {
    if (isEmployeePinUniqueViolation(error)) throw new Error("That PIN is already in use at this location.");
    throw error;
  }
  await sql`UPDATE credential_reset_tokens SET used_at = NOW() WHERE id = ${reset.id}`;
}
