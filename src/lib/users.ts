import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

export const appRoles = ["Owner", "Co-Owner", "Accountant", "Manager", "Viewer"] as const;
export type AppRole = (typeof appRoles)[number];

export type AppUserIdentity = {
  id: string;
  email: string;
  displayName: string;
  role: AppRole;
  businesses: Business[];
  permissions: string[];
  sessionVersion: number;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: AppRole;
  businesses: Business[] | string;
  password_salt: string;
  password_hash: string;
  legacy_owner: boolean;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  session_version: number;
};

const rolePermissions: Record<AppRole, string[]> = {
  Owner: ["*"],
  "Co-Owner": ["*"],
  Accountant: [
    "accounting.read",
    "accounting.write",
    "integrations.read",
    "integrations.write",
    "payroll.read",
    "reports.read",
    "documents.read",
  ],
  Manager: [
    "payroll.read",
    "payroll.write",
    "workforce.read",
    "workforce.write",
    "reports.read",
    "documents.read",
    "documents.write",
  ],
  Viewer: [
    "accounting.read",
    "payroll.read",
    "workforce.read",
    "integrations.read",
    "reports.read",
    "documents.read",
  ],
};

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalizedEmail(value: unknown): string {
  return clean(value, 320).toLowerCase();
}

function normalizeBusinesses(value: UserRow["businesses"]): Business[] {
  const values = Array.isArray(value) ? value : String(value || "").replace(/[{}]/g, "").split(",");
  return values.filter((item): item is Business => item === "Corner Deli" || item === "Tiki");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function passwordDigest(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("base64url");
}

function passwordRecord(password: string): { salt: string; hash: string } {
  if (password.length < 10) throw new Error("Passwords must contain at least 10 characters.");
  const salt = randomBytes(18).toString("base64url");
  return { salt, hash: passwordDigest(password, salt) };
}

export function permissionsForRole(role: AppRole): string[] {
  return [...rolePermissions[role]];
}

export function roleHasPermission(role: AppRole, permission: string): boolean {
  const permissions = rolePermissions[role];
  return permissions.includes("*") || permissions.includes(permission);
}

export async function ensureUserSchema(): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Owner', 'Co-Owner', 'Accountant', 'Manager', 'Viewer')),
      businesses TEXT[] NOT NULL DEFAULT ARRAY['Corner Deli', 'Tiki']::TEXT[],
      password_salt TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      legacy_owner BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      session_version INTEGER NOT NULL DEFAULT 1
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS app_users_active_idx ON app_users (active, role, email)`;

  const configuredOwnerEmail = process.env.APP_EMAIL?.trim();
  if (!configuredOwnerEmail) throw new Error("APP_EMAIL is required before user accounts can be initialized.");
  const ownerEmail = normalizedEmail(configuredOwnerEmail);
  await sql`
    INSERT INTO app_users (
      id, email, display_name, role, businesses, legacy_owner, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${ownerEmail}, 'Owner', 'Owner',
      ARRAY['Corner Deli', 'Tiki']::TEXT[], TRUE, 'System bootstrap'
    )
    ON CONFLICT (email) DO NOTHING
  `;
}

function mapUser(row: UserRow): AppUserIdentity & {
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  legacyOwner: boolean;
  passwordSet: boolean;
} {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    businesses: normalizeBusinesses(row.businesses),
    permissions: permissionsForRole(row.role),
    sessionVersion: Number(row.session_version || 1),
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    legacyOwner: row.legacy_owner,
    passwordSet: Boolean(row.password_hash && row.password_salt) || row.legacy_owner,
  };
}

async function rowByEmail(email: string): Promise<UserRow | null> {
  const rows = await getSql()`
    SELECT id, email, display_name, role, businesses, password_salt, password_hash,
      legacy_owner, active, created_by, created_at, updated_at, session_version
    FROM app_users
    WHERE email = ${normalizedEmail(email)}
    LIMIT 1
  ` as unknown as UserRow[];
  return rows[0] || null;
}

export async function authenticateAppUser(emailValue: unknown, passwordValue: unknown): Promise<AppUserIdentity | null> {
  await ensureUserSchema();
  const email = normalizedEmail(emailValue || process.env.APP_EMAIL || "");
  const password = String(passwordValue ?? "");
  const row = await rowByEmail(email);
  if (!row || !row.active) return null;

  let valid = false;
  if (row.password_hash && row.password_salt) {
    valid = safeEqual(passwordDigest(password, row.password_salt), row.password_hash);
  } else if (row.legacy_owner && Boolean(process.env.APP_EMAIL?.trim()) && email === normalizedEmail(process.env.APP_EMAIL)) {
    const legacyPassword = process.env.APP_PASSWORD || "";
    valid = Boolean(legacyPassword) && safeEqual(password, legacyPassword);
  }
  return valid ? mapUser(row) : null;
}

export async function listAppUsers() {
  await ensureUserSchema();
  const rows = await getSql()`
    SELECT id, email, display_name, role, businesses, password_salt, password_hash,
      legacy_owner, active, created_by, created_at, updated_at, session_version
    FROM app_users
    ORDER BY active DESC,
      CASE role WHEN 'Owner' THEN 1 WHEN 'Co-Owner' THEN 2 WHEN 'Accountant' THEN 3 WHEN 'Manager' THEN 4 ELSE 5 END,
      email
  ` as unknown as UserRow[];
  return rows.map(mapUser);
}

export async function saveAppUser(input: {
  id?: string;
  email: string;
  displayName: string;
  role: AppRole;
  businesses: Business[];
  password?: string;
  active?: boolean;
  actor: string;
}) {
  await ensureUserSchema();
  if (!appRoles.includes(input.role)) throw new Error("Unknown user role.");
  const email = normalizedEmail(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email address.");
  const businesses = input.businesses.filter((value): value is Business => value === "Corner Deli" || value === "Tiki");
  if (!businesses.length) throw new Error("Choose at least one business.");
  const cornerDeli = businesses.includes("Corner Deli");
  const tiki = businesses.includes("Tiki");
  const password = input.password ? passwordRecord(input.password) : null;

  if (input.id) {
    const existingRows = await getSql()`
      SELECT id, email, role, legacy_owner FROM app_users WHERE id = ${input.id} LIMIT 1
    ` as unknown as Array<{ id: string; email: string; role: AppRole; legacy_owner: boolean }>;
    const existing = existingRows[0];
    if (!existing) throw new Error("User was not found.");
    if (existing.role === "Owner" && input.role !== "Owner") throw new Error("The primary owner role cannot be removed.");
    await getSql()`
      UPDATE app_users SET
        email = ${email},
        display_name = ${clean(input.displayName, 120) || email},
        role = ${input.role},
        businesses = CASE
          WHEN ${cornerDeli} AND ${tiki} THEN ARRAY['Corner Deli', 'Tiki']::TEXT[]
          WHEN ${cornerDeli} THEN ARRAY['Corner Deli']::TEXT[]
          ELSE ARRAY['Tiki']::TEXT[]
        END,
        password_salt = CASE WHEN ${password?.salt || ""} = '' THEN password_salt ELSE ${password?.salt || ""} END,
        password_hash = CASE WHEN ${password?.hash || ""} = '' THEN password_hash ELSE ${password?.hash || ""} END,
        legacy_owner = CASE WHEN ${password?.hash || ""} = '' THEN legacy_owner ELSE FALSE END,
        active = ${input.active ?? true},
        session_version = session_version + 1, updated_at = NOW()
      WHERE id = ${input.id}
    `;
    return mapUser((await rowByEmail(email))!);
  }

  if (!password) throw new Error("A temporary password is required for a new user.");
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO app_users (
      id, email, display_name, role, businesses, password_salt, password_hash,
      legacy_owner, active, created_by
    ) VALUES (
      ${id}, ${email}, ${clean(input.displayName, 120) || email}, ${input.role},
      CASE
        WHEN ${cornerDeli} AND ${tiki} THEN ARRAY['Corner Deli', 'Tiki']::TEXT[]
        WHEN ${cornerDeli} THEN ARRAY['Corner Deli']::TEXT[]
        ELSE ARRAY['Tiki']::TEXT[]
      END,
      ${password.salt}, ${password.hash}, FALSE, ${input.active ?? true}, ${input.actor}
    )
  `;
  return mapUser((await rowByEmail(email))!);
}

export async function setUserActive(id: string, active: boolean) {
  await ensureUserSchema();
  const rows = await getSql()`SELECT role FROM app_users WHERE id = ${id} LIMIT 1` as unknown as Array<{ role: AppRole }>;
  if (!rows[0]) throw new Error("User was not found.");
  if (rows[0].role === "Owner" && !active) throw new Error("The primary owner cannot be deactivated.");
  await getSql()`UPDATE app_users SET active = ${active}, session_version = session_version + 1, updated_at = NOW() WHERE id = ${id}`;
  return { updated: true };
}
