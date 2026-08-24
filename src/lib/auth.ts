import { cookies } from "next/headers";
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
  return candidate.replace(/\b\w/g, (value) => value.toUpperCase());
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
