import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { assertConfigured } from "@/lib/config";
import { businesses, type Business } from "@/lib/types";

const COOKIE_NAME = "corner_ops_session";
const SESSION_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  email: string;
  businesses: Business[];
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

function createToken(payload: SessionPayload): string {
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

function parseToken(token: string): SessionPayload | null {
  const [encoded, suppliedSignature] = token.split(".");
  if (!encoded || !suppliedSignature || !safeEqual(signature(encoded), suppliedSignature)) return null;

  try {
    const payload = JSON.parse(decode(encoded)) as SessionPayload;
    if (!payload.email || !Array.isArray(payload.businesses) || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isValidPassword(candidate: string): boolean {
  assertConfigured("APP_PASSWORD");
  return safeEqual(candidate, process.env.APP_PASSWORD!);
}

export async function createSession(): Promise<SessionPayload> {
  const payload: SessionPayload = {
    email: process.env.APP_EMAIL?.trim() || "crfrary@gmail.com",
    businesses: [...businesses],
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, createToken(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
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
    secure: process.env.NODE_ENV === "production",
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
