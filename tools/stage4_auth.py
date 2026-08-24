from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
def read(path): return (ROOT/path).read_text()
def write(path,text): (ROOT/path).write_text(text)
def rep(path,old,new):
    text=read(path); count=text.count(old)
    if count!=1: raise RuntimeError(f"{path}: expected 1 match, got {count}: {old[:100]!r}")
    write(path,text.replace(old,new,1))
def sub(path,pattern,new):
    text=read(path); out,count=re.subn(pattern,lambda _m:new,text,count=1,flags=re.S)
    if count!=1: raise RuntimeError(f"{path}: expected 1 regex match, got {count}: {pattern[:100]}")
    write(path,out)

# Owner sessions: purpose-specific signing plus database-backed revocation/current permissions.
write('src/lib/auth.ts', '''import { cookies } from "next/headers";
import { getSql } from "@/lib/db";
import { PermissionError } from "@/lib/http";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";
import { businesses, type Business } from "@/lib/types";
import { appRoles, permissionsForRole, type AppRole, type AppUserIdentity } from "@/lib/users";

const COOKIE_NAME = "corner_ops_session";
const SESSION_SECONDS = 60 * 60 * 12;

export type SessionPayload = {
  userId?: string;
  email: string;
  displayName: string;
  role: AppRole;
  businesses: Business[];
  permissions: string[];
  sessionVersion?: number;
  expiresAt: number;
};

function encode(value: string): string { return Buffer.from(value, "utf8").toString("base64url"); }
function decode(value: string): string { return Buffer.from(value, "base64url").toString("utf8"); }
function signature(data: string): string { return hmacSignature(data, "owner-session", { envName: "OWNER_SESSION_SECRET" }); }

function displayName(nameValue: unknown, emailValue: unknown): string {
  const name = String(nameValue ?? "").trim();
  if (name && !name.includes("@")) return name;
  const email = String(emailValue ?? "").trim().toLowerCase();
  const localPart = email.split("@")[0] || "User";
  const candidate = localPart.split(/[._-]/).filter(Boolean).join(" ") || "User";
  return candidate.replace(/\\b\\w/g, (value) => value.toUpperCase());
}

function createToken(payload: SessionPayload): string {
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

function normalizePayload(value: Partial<SessionPayload>): SessionPayload | null {
  if (!value.email || !value.role || !appRoles.includes(value.role as AppRole)) return null;
  if (!Array.isArray(value.businesses) || !Array.isArray(value.permissions) || !value.permissions.length) return null;
  if (Number(value.expiresAt || 0) <= Date.now()) return null;
  const validBusinesses = value.businesses.filter((business): business is Business => businesses.includes(business as Business));
  if (!validBusinesses.length) return null;
  return {
    userId: value.userId ? String(value.userId) : undefined,
    email: String(value.email),
    displayName: displayName(value.displayName, value.email),
    role: value.role as AppRole,
    businesses: validBusinesses,
    permissions: value.permissions.filter((permission): permission is string => typeof permission === "string" && permission.length > 0),
    sessionVersion: Number(value.sessionVersion || 1),
    expiresAt: Number(value.expiresAt),
  };
}

function parseToken(token: string): SessionPayload | null {
  const [encoded, suppliedSignature] = token.split(".");
  if (!encoded || !suppliedSignature) return null;
  let signatureValid = false;
  try {
    signatureValid = constantTimeEqual(signature(encoded), suppliedSignature)
      || constantTimeEqual(legacySessionHmac(encoded), suppliedSignature);
  } catch {
    return null;
  }
  if (!signatureValid) return null;
  try { return normalizePayload(JSON.parse(decode(encoded)) as Partial<SessionPayload>); } catch { return null; }
}

export async function createSession(identity: AppUserIdentity): Promise<SessionPayload> {
  const payload: SessionPayload = {
    userId: identity.id,
    email: identity.email,
    displayName: displayName(identity.displayName, identity.email),
    role: identity.role,
    businesses: [...identity.businesses],
    permissions: [...identity.permissions],
    sessionVersion: identity.sessionVersion,
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, createToken(payload), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_SECONDS,
  });
  return payload;
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  if (!process.env.OWNER_SESSION_SECRET && !process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const parsed = token ? parseToken(token) : null;
  if (!parsed) return null;
  const rows = await getSql()`
    SELECT id, email, display_name, role, businesses, session_version, active
    FROM app_users
    WHERE LOWER(email) = LOWER(${parsed.email})
    LIMIT 1
  ` as unknown as Array<{ id: string; email: string; display_name: string; role: AppRole; businesses: Business[] | string; session_version: number; active: boolean }>;
  const user = rows[0];
  if (!user?.active || Number(user.session_version || 1) != Number(parsed.sessionVersion || 1)) return null;
  const values = Array.isArray(user.businesses) ? user.businesses : String(user.businesses || "").replace(/[{}]/g, "").split(",");
  const currentBusinesses = values.filter((business): business is Business => businesses.includes(business as Business));
  if (!currentBusinesses.length || !appRoles.includes(user.role)) return null;
  return {
    userId: user.id,
    email: user.email,
    displayName: displayName(user.display_name, user.email),
    role: user.role,
    businesses: currentBusinesses,
    permissions: permissionsForRole(user.role),
    sessionVersion: Number(user.session_version || 1),
    expiresAt: parsed.expiresAt,
  };
}

export function canAccessBusiness(session: SessionPayload, business: string): business is Business {
  return session.businesses.includes(business as Business);
}
export function hasPermission(session: SessionPayload, permission: string): boolean {
  return session.permissions.includes("*") || session.permissions.includes(permission);
}
export function requirePermission(session: SessionPayload, permission: string): void {
  if (!hasPermission(session, permission)) throw new PermissionError();
}
''')

# App users expose and increment revocation version.
rep('src/lib/users.ts','  permissions: string[];\n};','  permissions: string[];\n  sessionVersion: number;\n};')
rep('src/lib/users.ts','  updated_at: string;\n};','  updated_at: string;\n  session_version: number;\n};')
rep('src/lib/users.ts','    permissions: permissionsForRole(row.role),\n','    permissions: permissionsForRole(row.role),\n    sessionVersion: Number(row.session_version || 1),\n')
# all row selects used by mapUser/rowByEmail/list
text=read('src/lib/users.ts')
text=text.replace('legacy_owner, active, created_by, created_at, updated_at\n    FROM app_users','legacy_owner, active, created_by, created_at, updated_at, session_version\n    FROM app_users')
text=text.replace('legacy_owner, active, created_by, created_at, updated_at\n    FROM app_users\n    ORDER BY','legacy_owner, active, created_by, created_at, updated_at, session_version\n    FROM app_users\n    ORDER BY')
write('src/lib/users.ts',text)
rep('src/lib/users.ts','        active = ${input.active ?? true},\n        updated_at = NOW()\n','        active = ${input.active ?? true},\n        session_version = session_version + 1, updated_at = NOW()\n')
rep('src/lib/users.ts','  await getSql()`UPDATE app_users SET active = ${active}, updated_at = NOW() WHERE id = ${id}`;','  await getSql()`UPDATE app_users SET active = ${active}, session_version = session_version + 1, updated_at = NOW() WHERE id = ${id}`;')

# Employee session is signed independently, checked against DB, and authenticates through the shared PIN verifier.
write('src/lib/employee-auth.ts','''import { cookies } from "next/headers";
import { getSql } from "@/lib/db";
import { employeeByPin } from "@/lib/employee-pin-security";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";
import type { Business } from "@/lib/types";

const EMPLOYEE_COOKIE = "corner_ops_employee";
const EMPLOYEE_SESSION_SECONDS = 60 * 60 * 24 * 14;

export type EmployeeSession = {
  employeeId: string;
  business: Business;
  name: string;
  position: string;
  sessionVersion?: number;
  expiresAt: number;
};

function sign(value: string): string { return hmacSignature(value, "employee-session", { envName: "EMPLOYEE_SESSION_SECRET" }); }
function encode(payload: EmployeeSession): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}
function decode(token: string): EmployeeSession | null {
  const [body, supplied] = token.split(".");
  if (!body || !supplied) return null;
  let valid = false;
  try { valid = constantTimeEqual(sign(body), supplied) || constantTimeEqual(legacySessionHmac(body), supplied); } catch { return null; }
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EmployeeSession;
    if (!payload.employeeId || !payload.name || !payload.business || payload.expiresAt <= Date.now()) return null;
    return { ...payload, sessionVersion: Number(payload.sessionVersion || 1) };
  } catch { return null; }
}

export async function createEmployeeSession(business: Business, suppliedPin: string): Promise<EmployeeSession> {
  const employee = await employeeByPin(business, suppliedPin);
  if (!employee) throw new Error("PIN not recognized for this location.");
  const payload: EmployeeSession = {
    employeeId: employee.id, business: employee.business, name: employee.name, position: employee.position,
    sessionVersion: Number(employee.session_version || 1), expiresAt: Date.now() + EMPLOYEE_SESSION_SECONDS * 1000,
  };
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, encode(payload), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: EMPLOYEE_SESSION_SECONDS,
  });
  return payload;
}

export async function getEmployeeSession(): Promise<EmployeeSession | null> {
  if (!process.env.EMPLOYEE_SESSION_SECRET && !process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(EMPLOYEE_COOKIE)?.value;
  const parsed = token ? decode(token) : null;
  if (!parsed) return null;
  const rows = await getSql()`
    SELECT id, business, name, position, session_version, active, pin_enabled
    FROM employees WHERE id = ${parsed.employeeId} AND business = ${parsed.business} LIMIT 1
  ` as unknown as Array<{ id: string; business: Business; name: string; position: string; session_version: number; active: boolean; pin_enabled: boolean }>;
  const employee = rows[0];
  if (!employee?.active || !employee.pin_enabled || Number(employee.session_version || 1) !== Number(parsed.sessionVersion || 1)) return null;
  return { ...parsed, name: employee.name, position: employee.position, sessionVersion: Number(employee.session_version || 1) };
}

export async function clearEmployeeSession(): Promise<void> {
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
}
''')

# Display tokens share the PIN verifier but have their own signature and live revocation check.
write('src/lib/deli-board-auth.ts','''import { getSql } from "@/lib/db";
import { employeeByPin } from "@/lib/employee-pin-security";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";

const BUSINESS = "Corner Deli" as const;
const TOKEN_SECONDS = 60 * 60 * 24 * 30;
const SCOPE = "deli-board" as const;

export type DeliBoardTokenPayload = {
  scope: typeof SCOPE;
  business: typeof BUSINESS;
  employeeId: string;
  employeeName: string;
  sessionVersion?: number;
  expiresAt: number;
};

function sign(value: string): string { return hmacSignature(value, "deli-board-session", { envName: "DELI_BOARD_SESSION_SECRET" }); }
function encode(payload: DeliBoardTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export async function verifyDeliBoardToken(token: string | null | undefined): Promise<DeliBoardTokenPayload | null> {
  if (!token || (!process.env.DELI_BOARD_SESSION_SECRET && !process.env.SESSION_SECRET)) return null;
  const [body, supplied] = token.split(".");
  if (!body || !supplied) return null;
  let valid = false;
  try { valid = constantTimeEqual(sign(body), supplied) || constantTimeEqual(legacySessionHmac(body), supplied); } catch { return null; }
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DeliBoardTokenPayload;
    if (payload.scope !== SCOPE || payload.business !== BUSINESS || !payload.employeeId || !payload.employeeName || payload.expiresAt <= Date.now()) return null;
    const rows = await getSql()`
      SELECT name, session_version, active, pin_enabled FROM employees
      WHERE id = ${payload.employeeId} AND business = ${BUSINESS} LIMIT 1
    ` as unknown as Array<{ name: string; session_version: number; active: boolean; pin_enabled: boolean }>;
    const employee = rows[0];
    if (!employee?.active || !employee.pin_enabled || Number(employee.session_version || 1) !== Number(payload.sessionVersion || 1)) return null;
    return { ...payload, employeeName: employee.name, sessionVersion: Number(employee.session_version || 1) };
  } catch { return null; }
}

export async function createDeliBoardToken(suppliedPin: string) {
  const employee = await employeeByPin(BUSINESS, suppliedPin);
  if (!employee) throw new Error("PIN not recognized for Corner Deli.");
  const payload: DeliBoardTokenPayload = {
    scope: SCOPE, business: BUSINESS, employeeId: employee.id, employeeName: employee.name,
    sessionVersion: Number(employee.session_version || 1), expiresAt: Date.now() + TOKEN_SECONDS * 1000,
  };
  return { token: encode(payload), payload };
}
''')
rep('src/app/api/deli-board/route.ts','  const display = verifyDeliBoardToken(bearerToken(request));\n','  const display = await verifyDeliBoardToken(bearerToken(request));\n')

# Directory creation/admin/reset use v2 salted PIN records and increment session version when credentials or activation change.
rep('src/lib/employee-directory.ts','import { createHmac } from "node:crypto";\n','')
rep('src/lib/employee-directory.ts','import { validateEmployeePin } from "@/lib/employee-pin";\n','import { assertEmployeePinAvailable, createEmployeePinRecord } from "@/lib/employee-pin-security";\n')
sub('src/lib/employee-directory.ts',r'\nfunction pinHash\(business: Business, pin: string\): string \{.*?\n\}', '')
rep('src/lib/employee-directory.ts','    const pin = validateEmployeePin(business, input.pin, name || "Employee");\n','    const pin = await assertEmployeePinAvailable({ business, pin: input.pin, employeeName: name || "Employee", excludeEmployeeId: undefined });\n    const pinRecord = createEmployeePinRecord(business, pin, name || "Employee");\n')
rep('src/lib/employee-directory.ts','''          pin_hash = ${pinHash(business, pin)}, pin_enabled = TRUE,
          position = ${position},''','''          pin_hash = ${pinRecord.hash}, pin_salt = ${pinRecord.salt}, pin_hash_version = ${pinRecord.version},
          pin_fingerprint = ${pinRecord.fingerprint}, pin_enabled = TRUE, session_version = session_version + 1,
          position = ${position},''')
rep('src/lib/employee-directory.ts','''          id, business, email, phone, sms_opt_in, name, pin_hash, pin_enabled, position,
          role_group, counts_for_tips, hourly_rate, tipped_rate, active
        ) VALUES (
          ${crypto.randomUUID()}, ${business}, ${email}, ${phone}, ${smsOptIn}, ${name},
          ${pinHash(business, pin)}, TRUE, ${position},''','''          id, business, email, phone, sms_opt_in, name, pin_hash, pin_salt, pin_hash_version, pin_fingerprint,
          pin_enabled, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active
        ) VALUES (
          ${crypto.randomUUID()}, ${business}, ${email}, ${phone}, ${smsOptIn}, ${name},
          ${pinRecord.hash}, ${pinRecord.salt}, ${pinRecord.version}, ${pinRecord.fingerprint}, TRUE, ${position},''')

rep('src/lib/employee-directory-admin.ts','import { createHmac } from "node:crypto";\n','')
rep('src/lib/employee-directory-admin.ts','import { employeePinLength, validateEmployeePin } from "@/lib/employee-pin";\n','import { employeePinLength, validateEmployeePin } from "@/lib/employee-pin";\nimport { assertEmployeePinAvailable, createEmployeePinRecord, isEmployeePinUniqueViolation } from "@/lib/employee-pin-security";\n')
sub('src/lib/employee-directory-admin.ts',r'\nfunction pinHash\(business: Business, pin: string\): string \{.*?\n\}', '')
rep('src/lib/employee-directory-admin.ts','''    const rows = await sql`
      UPDATE employees
      SET pin_hash = ${pinHash(input.business, entry.pin)}, pin_enabled = TRUE,
        active = TRUE, updated_at = NOW()
''','''    await assertEmployeePinAvailable({ business: input.business, pin: entry.pin, employeeName: entry.name });
    const record = createEmployeePinRecord(input.business, entry.pin, entry.name);
    const rows = await sql`
      UPDATE employees
      SET pin_hash = ${record.hash}, pin_salt = ${record.salt}, pin_hash_version = ${record.version},
        pin_fingerprint = ${record.fingerprint}, pin_enabled = TRUE,
        active = TRUE, session_version = session_version + 1, updated_at = NOW()
''')
rep('src/lib/employee-directory-admin.ts','  const pin = input.pin ? validateEmployeePin(input.business, input.pin, name) : "";\n','  const pin = input.pin ? await assertEmployeePinAvailable({ business: input.business, pin: validateEmployeePin(input.business, input.pin, name), employeeName: name, excludeEmployeeId: input.id }) : "";\n  const pinRecord = pin ? createEmployeePinRecord(input.business, pin, name) : null;\n')
rep('src/lib/employee-directory-admin.ts','''      pin_hash = CASE WHEN ${pin} <> '' THEN ${pin ? pinHash(input.business, pin) : ""} ELSE pin_hash END,
      pin_enabled = CASE WHEN ${pin} <> '' THEN TRUE ELSE pin_enabled END, updated_at = NOW()
''','''      pin_hash = CASE WHEN ${pin} <> '' THEN ${pinRecord?.hash || ""} ELSE pin_hash END,
      pin_salt = CASE WHEN ${pin} <> '' THEN ${pinRecord?.salt || ""} ELSE pin_salt END,
      pin_hash_version = CASE WHEN ${pin} <> '' THEN ${pinRecord?.version || 1} ELSE pin_hash_version END,
      pin_fingerprint = CASE WHEN ${pin} <> '' THEN ${pinRecord?.fingerprint || ""} ELSE pin_fingerprint END,
      pin_enabled = CASE WHEN ${pin} <> '' THEN TRUE ELSE pin_enabled END,
      session_version = CASE WHEN ${pin} <> '' OR active <> ${active} THEN session_version + 1 ELSE session_version END,
      updated_at = NOW()
''')

# Password/PIN reset revokes sessions and uses the canonical business-aware PIN validator/storage.
rep('src/lib/credential-resets.ts','import { createHash, createHmac, randomBytes, randomUUID, scryptSync } from "node:crypto";\n','import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";\n')
rep('src/lib/credential-resets.ts','import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";\n','import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";\nimport { assertEmployeePinAvailable, createEmployeePinRecord, isEmployeePinUniqueViolation } from "@/lib/employee-pin-security";\nimport { employeePinLabel } from "@/lib/employee-pin";\n')
sub('src/lib/credential-resets.ts',r'\nfunction employeePinHash\(business: Business, pin: string\): string \{.*?\n\}', '')
rep('src/lib/credential-resets.ts','        legacy_owner = FALSE, updated_at = NOW()\n','        legacy_owner = FALSE, session_version = session_version + 1, updated_at = NOW()\n')
rep('src/lib/credential-resets.ts','      `A five-digit Employee Hub PIN reset was requested for ${employee.business}.`,\n','      `A ${employeePinLabel(employee.business).toLowerCase()} reset was requested for ${employee.business}.`,\n')
sub('src/lib/credential-resets.ts',r'export async function completeEmployeePinReset\(input: \{ token: string; pin: string \}\): Promise<void> \{.*?\n\}', '''export async function completeEmployeePinReset(input: { token: string; pin: string }): Promise<void> {
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
}''')

print('Stage 4 auth and PIN transformations applied')
