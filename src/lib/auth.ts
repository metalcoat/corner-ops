import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { assertConfigured } from "@/lib/config";
import { businesses, type Business } from "@/lib/types";
import { permissionsForRole, type AppRole, type AppUserIdentity } from "@/lib/users";
import { secureCookies } from "@/lib/cookie-security";

const COOKIE_NAME = "corner_ops_session";
const SESSION_SECONDS = 60 * 60 * 12;

export type SessionPayload = {
  email: string;
  displayName: string;
  role: AppRole;
  businesses: Business[];
  permissions: string[];
  expiresAt: number;
};

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(data: string): string {
  assertConfigured("SESSION_SECRET");
  return createHmac("sha256", process.env.SESSION_SECRET!).update(data).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function firstName(nameValue: unknown, emailValue: unknown): string {
  const name = String(nameValue ?? "").trim();
  const email = String(emailValue ?? "").trim().toLowerCase();
  const ownerEmail = (process.env.APP_EMAIL || "crfrary@gmail.com").trim().toLowerCase();

  if (name && name !== "Owner" && !name.includes("@")) return name.split(/\s+/)[0];
  if (email === ownerEmail) return "Chris";

  const localPart = email.split("@")[0] || name.split("@")[0] || "Owner";
  const candidate = localPart.split(/[._-]/)[0] || "Owner";
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

function createToken(payload: SessionPayload): string {
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

function normalizePayload(value: Partial<SessionPayload>): SessionPayload | null {
  if (!value.email || !Array.isArray(value.businesses) || Number(value.expiresAt || 0) <= Date.now()) return null;
  const role = value.role || "Owner";
  const validBusinesses = value.businesses.filter((business): business is Business => businesses.includes(business as Business));
  return {
    email: value.email,
    displayName: firstName(value.displayName, value.email),
    role,
    businesses: validBusinesses,
    permissions: Array.isArray(value.permissions) && value.permissions.length ? value.permissions : permissionsForRole(role),
    expiresAt: Number(value.expiresAt),
  };
}

function parseToken(token: string): SessionPayload | null {
  const [encoded, suppliedSignature] = token.split(".");
  if (!encoded || !suppliedSignature || !safeEqual(signature(encoded), suppliedSignature)) return null;
  try {
    return normalizePayload(JSON.parse(decode(encoded)) as Partial<SessionPayload>);
  } catch {
    return null;
  }
}

export function isValidPassword(candidate: string): boolean {
  assertConfigured("APP_PASSWORD");
  return safeEqual(candidate, process.env.APP_PASSWORD!);
}

export async function createSession(identity?: AppUserIdentity): Promise<SessionPayload> {
  const email = identity?.email || process.env.APP_EMAIL?.trim().toLowerCase() || "crfrary@gmail.com";
  const payload: SessionPayload = {
    email,
    displayName: firstName(identity?.displayName, email),
    role: identity?.role || "Owner",
    businesses: identity?.businesses?.length ? [...identity.businesses] : [...businesses],
    permissions: identity?.permissions?.length ? [...identity.permissions] : ["*"],
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, createToken(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return payload;
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 0,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  if (!process.env.SESSION_SECRET) return null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  return token ? parseToken(token) : null;
}

export function canAccessBusiness(session: SessionPayload, business: string): business is Business {
  return session.businesses.includes(business as Business);
}

export function hasPermission(session: SessionPayload, permission: string): boolean {
  return session.permissions.includes("*") || session.permissions.includes(permission);
}

export function requirePermission(session: SessionPayload, permission: string): void {
  if (!hasPermission(session, permission)) throw new Error("Your account does not have permission for this action.");
}
