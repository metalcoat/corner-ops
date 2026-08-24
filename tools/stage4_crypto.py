from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
 t=read(p); c=t.count(o)
 if c!=1: raise RuntimeError(f'{p}: expected 1 match, got {c}: {o[:100]!r}')
 write(p,t.replace(o,n,1))
def sub(p,pat,n):
 t=read(p); x,c=re.subn(pat,lambda _m:n,t,count=1,flags=re.S)
 if c!=1: raise RuntimeError(f'{p}: expected 1 regex match, got {c}: {pat[:100]}')
 write(p,x)

# Shared integration encryption and one-time OAuth state.
rep('src/lib/integrations.ts',
'import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";\n',
'import { createHash } from "node:crypto";\n')
rep('src/lib/integrations.ts','import { ValidationError } from "@/lib/http";\n',
'import { ValidationError } from "@/lib/http";\nimport { decryptIntegrationSecret as decryptSecret, encryptIntegrationSecret as encryptSecret } from "@/lib/integration-crypto";\nimport { consumeOAuthState, createOAuthState } from "@/lib/oauth-state";\n')
sub('src/lib/integrations.ts',r'\nfunction integrationKey\(\): Buffer \{.*?\nfunction allowedOrigin\(origin: string\): string \{', '\nfunction allowedOrigin(origin: string): string {')
rep('src/lib/integrations.ts','export function squareAuthorizationUrl(origin: string): string {','export async function squareAuthorizationUrl(origin: string): Promise<string> {')
rep('src/lib/integrations.ts','  const state = signedState({ origin: safeOrigin, redirectUri, business: "Tiki", expiresAt: Date.now() + 10 * 60_000 });','  const state = await createOAuthState({ origin: safeOrigin, redirectUri, business: "Tiki", expiresAt: Date.now() + 10 * 60_000 });')
rep('src/lib/integrations.ts','  const payload = readSignedState(state);','  const payload = await consumeOAuthState(state);')

# Square control uses the same credential crypto and OAuth state producer.
rep('src/lib/square-control.ts',
'import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";\n',
'import { createHmac } from "node:crypto";\n')
rep('src/lib/square-control.ts','import { getSql } from "@/lib/db";\n',
'import { getSql } from "@/lib/db";\nimport { decryptIntegrationSecret as decryptSecret, encryptIntegrationSecret as encryptSecret } from "@/lib/integration-crypto";\nimport { createOAuthState } from "@/lib/oauth-state";\nimport { constantTimeEqual } from "@/lib/security-keys";\n')
sub('src/lib/square-control.ts',r'\nfunction integrationKey\(\): Buffer \{.*?\nfunction squareEnvironment\(\): "sandbox" \| "production" \{', '\nfunction squareEnvironment(): "sandbox" | "production" {')
sub('src/lib/square-control.ts',r'\nfunction safeEqual\(left: string, right: string\): boolean \{.*?\n\}', '')
sub('src/lib/square-control.ts',r'\nfunction signedState\(payload: Record<string, unknown>\): string \{.*?\n\}', '')
rep('src/lib/square-control.ts','export function squareFullAuthorizationUrl(origin: string): string {','export async function squareFullAuthorizationUrl(origin: string): Promise<string> {')
rep('src/lib/square-control.ts','  const state = signedState({ origin: safeOrigin, redirectUri, business: "Tiki", expiresAt: Date.now() + 10 * 60_000 });','  const state = await createOAuthState({ origin: safeOrigin, redirectUri, business: "Tiki", expiresAt: Date.now() + 10 * 60_000 });')
rep('src/lib/square-control.ts','  return safeEqual(expected, suppliedSignature);','  return constantTimeEqual(expected, suppliedSignature);')
rep('src/app/api/square/connect/route.ts','    return Response.redirect(squareFullAuthorizationUrl(new URL(request.url).origin), 302);','    return Response.redirect(await squareFullAuthorizationUrl(new URL(request.url).origin), 302);')

# VAPID: preserve the currently deployed keypair once, encrypt it under independent key material, then stop deriving from SESSION_SECRET.
rep('src/lib/push-notifications.ts','  createHash,\n','  createHash,\n')
rep('src/lib/push-notifications.ts','import { ensureSchema, getSql } from "@/lib/db";\n',
'import { ensureSchema, getSql } from "@/lib/db";\nimport { legacySessionSecret, openApplicationSecret, sealApplicationSecret } from "@/lib/security-keys";\n')
sub('src/lib/push-notifications.ts',r'function pushKeys\(\) \{.*?\n\}', '''async function pushKeys() {
  const configuredPrivate = process.env.PUSH_VAPID_PRIVATE_KEY?.trim();
  const configuredPublic = process.env.PUSH_VAPID_PUBLIC_KEY?.trim();
  if (configuredPrivate && configuredPublic) {
    return { privateKey: decodeBase64url(configuredPrivate), publicKey: decodeBase64url(configuredPublic) };
  }

  const rows = await getSql()`
    SELECT encrypted_private_value, public_value
    FROM application_key_material WHERE purpose = 'web-push-vapid-v1' LIMIT 1
  ` as unknown as Array<{ encrypted_private_value: string; public_value: string }>;
  if (rows[0]) {
    return {
      privateKey: decodeBase64url(openApplicationSecret(rows[0].encrypted_private_value)),
      publicKey: decodeBase64url(rows[0].public_value),
    };
  }

  const digest = createHash("sha256").update(`corner-ops-web-push-v1:${legacySessionSecret()}`).digest();
  let scalar = BigInt(`0x${digest.toString("hex")}`);
  scalar = (scalar % (P256_ORDER - 1n)) + 1n;
  const privateKey = Buffer.from(scalar.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
  await getSql()`
    INSERT INTO application_key_material (purpose, encrypted_private_value, public_value)
    VALUES ('web-push-vapid-v1', ${sealApplicationSecret(base64url(privateKey))}, ${base64url(publicKey)})
    ON CONFLICT (purpose) DO NOTHING
  `;
  const persisted = await getSql()`
    SELECT encrypted_private_value, public_value
    FROM application_key_material WHERE purpose = 'web-push-vapid-v1' LIMIT 1
  ` as unknown as Array<{ encrypted_private_value: string; public_value: string }>;
  if (persisted[0]) {
    return {
      privateKey: decodeBase64url(openApplicationSecret(persisted[0].encrypted_private_value)),
      publicKey: decodeBase64url(persisted[0].public_value),
    };
  }
  return { privateKey, publicKey };
}''')
rep('src/lib/push-notifications.ts','function vapidAuthorization(endpoint: string) {\n  const { privateKey, publicKey } = pushKeys();','async function vapidAuthorization(endpoint: string) {\n  const { privateKey, publicKey } = await pushKeys();')
rep('src/lib/push-notifications.ts','export function pushPublicKey(): string {\n  return base64url(pushKeys().publicKey);\n}','export async function pushPublicKey(): Promise<string> {\n  return base64url((await pushKeys()).publicKey);\n}')
rep('src/lib/push-notifications.ts','  return { actorType: actor.type, publicKey: pushPublicKey(), subscribedDevices: count };','  return { actorType: actor.type, publicKey: await pushPublicKey(), subscribedDevices: count };')
rep('src/lib/push-notifications.ts','  const { authorization } = vapidAuthorization(subscription.endpoint);','  const { authorization } = await vapidAuthorization(subscription.endpoint);')

print('Stage 4 crypto transformations applied')
