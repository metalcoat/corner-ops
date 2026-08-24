import { createHash, randomBytes } from "node:crypto";
import { getSql } from "@/lib/db";
import { constantTimeEqual, hmacSignature, legacySessionHmac } from "@/lib/security-keys";

function encode(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(value: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OAuth authorization state is invalid.");
  return parsed as Record<string, unknown>;
}

function signature(encoded: string): string {
  return hmacSignature(encoded, "square-oauth-state", { envName: "SQUARE_OAUTH_STATE_SECRET" });
}

function nonceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createOAuthState(payload: Record<string, unknown>, purpose = "square"): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = Number(payload.expiresAt || Date.now() + 10 * 60_000);
  const body = { ...payload, nonce, expiresAt };
  await getSql()`
    INSERT INTO oauth_state_nonces (nonce_hash, purpose, expires_at)
    VALUES (${nonceHash(nonce)}, ${purpose}, ${new Date(expiresAt).toISOString()})
    ON CONFLICT (nonce_hash) DO NOTHING
  `;
  const encoded = encode(body);
  return `${encoded}.${signature(encoded)}`;
}

export async function consumeOAuthState(value: string, purpose = "square"): Promise<Record<string, unknown>> {
  const [encoded, supplied] = String(value || "").split(".");
  if (!encoded || !supplied) throw new Error("Integration authorization state is invalid.");
  let valid = false;
  try {
    valid = constantTimeEqual(signature(encoded), supplied)
      || constantTimeEqual(legacySessionHmac(encoded), supplied);
  } catch {
    throw new Error("Integration authorization state is invalid.");
  }
  if (!valid) throw new Error("Integration authorization state is invalid.");
  const payload = decode(encoded);
  if (Number(payload.expiresAt || 0) < Date.now()) throw new Error("Integration authorization state expired.");
  const nonce = String(payload.nonce || "");
  if (!nonce) return payload; // Legacy in-flight state created before nonce enforcement.
  const rows = await getSql()`
    UPDATE oauth_state_nonces SET used_at = NOW()
    WHERE nonce_hash = ${nonceHash(nonce)} AND purpose = ${purpose}
      AND used_at IS NULL AND expires_at > NOW()
    RETURNING nonce_hash
  ` as unknown as Array<{ nonce_hash: string }>;
  if (!rows[0]) throw new Error("Integration authorization state was already used or expired.");
  return payload;
}
