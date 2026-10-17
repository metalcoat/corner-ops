// Always-on store screens (the status board monitor and the label station)
// must never time out. Once someone signs in on one, the screen keeps its own
// pass for that one view; it lasts until a manager signs the screen out.
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { getSql } from "@/lib/db";
import { getSession, canAccessBusiness } from "@/lib/auth";
import { getPosSession } from "@/lib/pos-auth";
import { secureCookies } from "@/lib/cookie-security";
import { constantTimeEqual, hmacSignature } from "@/lib/security-keys";

export type ScreenKind = "board" | "labels";
const COOKIE = (kind: ScreenKind) => `corner_ops_screen_${kind}`;
const TEN_YEARS = 60 * 60 * 24 * 365 * 10;

let ready: Promise<void> | null = null;
function ensureSchema() {
  ready ??= (async () => {
    await getSql()`CREATE TABLE IF NOT EXISTS ordering_store_screens(
      id UUID PRIMARY KEY,
      business TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('board','labels')),
      name TEXT NOT NULL,
      signed_in_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ)`;
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

const sign = (body: string) => hmacSignature(body, "store-screen");

/** Who is signed in right now (POS PIN or office login) and allowed to set up a store screen. */
export async function screenSigner() {
  const pos = await getPosSession(false);
  if (pos) return { name: pos.name, manager: ["manager", "owner"].includes(String(pos.posRole)) };
  const office = await getSession();
  if (office && canAccessBusiness(office, "Corner Deli"))
    return { name: office.displayName || office.email, manager: ["Owner", "Co-Owner", "Manager"].includes(String(office.role)) };
  return null;
}

/** This screen's pass for one view, if it has one that hasn't been signed out. */
export async function currentScreen(kind: ScreenKind) {
  const raw = (await cookies()).get(COOKIE(kind))?.value;
  if (!raw) return null;
  const [body, signature] = raw.split(".");
  if (!body || !signature || !constantTimeEqual(sign(body), signature)) return null;
  let payload: { id?: string; kind?: string };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.kind !== kind || !payload.id) return null;
  await ensureSchema();
  const row = (await getSql()`UPDATE ordering_store_screens SET last_seen_at=NOW() WHERE id=${payload.id} AND kind=${kind} AND revoked_at IS NULL RETURNING id,name,kind`)[0];
  return row ? { id: String(row.id), name: String(row.name), kind } : null;
}

/** Keeps this screen signed in for one view, using whoever is signed in now. */
export async function signInScreen(kind: ScreenKind, name: string) {
  const signer = await screenSigner();
  if (!signer) throw new Error("Sign in first, then keep this screen signed in.");
  await ensureSchema();
  const id = randomUUID();
  const label = name.trim().slice(0, 60) || (kind === "board" ? "Status board" : "Label station");
  await getSql()`INSERT INTO ordering_store_screens(id,business,kind,name,signed_in_by) VALUES(${id},'Corner Deli',${kind},${label},${signer.name})`;
  const body = Buffer.from(JSON.stringify({ id, kind }), "utf8").toString("base64url");
  (await cookies()).set(COOKIE(kind), `${body}.${sign(body)}`, { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/", maxAge: TEN_YEARS });
  return { id, name: label, kind };
}

export async function signOutScreen(kind: ScreenKind) {
  const screen = await currentScreen(kind);
  if (screen) await getSql()`UPDATE ordering_store_screens SET revoked_at=NOW() WHERE id=${screen.id}`;
  (await cookies()).set(COOKIE(kind), "", { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/", maxAge: 0 });
}

export async function listScreens() {
  await ensureSchema();
  return getSql()`SELECT id,kind,name,signed_in_by,created_at,last_seen_at FROM ordering_store_screens WHERE business='Corner Deli' AND revoked_at IS NULL ORDER BY kind,created_at`;
}

export async function revokeScreen(id: string) {
  await ensureSchema();
  await getSql()`UPDATE ordering_store_screens SET revoked_at=NOW() WHERE id=${id} AND revoked_at IS NULL`;
}
