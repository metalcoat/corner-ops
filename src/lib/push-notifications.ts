import {
  createCipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { legacySessionSecret, openApplicationSecret, sealApplicationSecret } from "@/lib/security-keys";
import type { Business } from "@/lib/types";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const PUSH_SUBJECT = process.env.PUSH_SUBJECT?.trim() || "mailto:crfrary@gmail.com";
const MAX_PAYLOAD_BYTES = 3000;
let pushSchemaPromise: Promise<void> | null = null;

type PushActor =
  | { type: "owner"; email: string }
  | { type: "employee"; employeeId: string; business: Business };

type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  deviceLabel?: string;
};

type PushMessage = {
  title: string;
  body: string;
  url: string;
  tag: string;
  category?: string;
  business?: Business;
};

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function requestBody(value: Buffer): ArrayBuffer {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

async function pushKeys() {
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
}

function hmac(key: Buffer, value: Buffer): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const parts: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(parts).length < length) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    parts.push(previous);
    counter += 1;
  }
  return Buffer.concat(parts).subarray(0, length);
}

async function vapidAuthorization(endpoint: string) {
  const { privateKey, publicKey } = await pushKeys();
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64url(Buffer.from(JSON.stringify({ aud: audience, exp: now + 43_200, sub: PUSH_SUBJECT })));
  const unsigned = `${header}.${payload}`;
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: base64url(privateKey),
      x: base64url(publicKey.subarray(1, 33)),
      y: base64url(publicKey.subarray(33, 65)),
    },
    format: "jwk",
  });
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return {
    authorization: `vapid t=${unsigned}.${base64url(signature)}, k=${base64url(publicKey)}`,
    publicKey: base64url(publicKey),
  };
}

function encryptedPayload(subscription: StoredSubscription, message: PushMessage): Buffer {
  const clientPublicKey = decodeBase64url(subscription.p256dh);
  const authSecret = decodeBase64url(subscription.auth);
  if (clientPublicKey.length !== 65 || authSecret.length === 0) throw new Error("Push subscription keys are invalid.");

  const server = createECDH("prime256v1");
  server.generateKeys();
  const serverPublicKey = server.getPublicKey(undefined, "uncompressed");
  const sharedSecret = server.computeSecret(clientPublicKey);
  const authPrk = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPublicKey, serverPublicKey]);
  const inputKeyMaterial = hkdfExpand(authPrk, keyInfo, 32);
  const salt = randomBytes(16);
  const contentPrk = hmac(salt, inputKeyMaterial);
  const contentKey = hkdfExpand(contentPrk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(contentPrk, Buffer.from("Content-Encoding: nonce\0"), 12);

  let json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_PAYLOAD_BYTES) {
    json = Buffer.from(JSON.stringify({ ...message, body: clean(message.body, 500) }), "utf8");
  }
  const plaintext = Buffer.concat([json, Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublicKey.length]), serverPublicKey, ciphertext]);
}

export async function ensurePushSchema(): Promise<void> {
  if (!pushSchemaPromise) {
    pushSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id UUID PRIMARY KEY,
          endpoint TEXT NOT NULL UNIQUE,
          audience_type TEXT NOT NULL CHECK (audience_type IN ('owner', 'employee')),
          owner_email TEXT NOT NULL DEFAULT '',
          employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
          business TEXT CHECK (business IN ('Corner Deli', 'Tiki')),
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          expiration_time BIGINT,
          user_agent TEXT NOT NULL DEFAULT '',
          device_label TEXT NOT NULL DEFAULT '',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          last_used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (
            (audience_type = 'owner' AND owner_email <> '' AND employee_id IS NULL)
            OR (audience_type = 'employee' AND employee_id IS NOT NULL AND business IS NOT NULL)
          )
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS push_subscriptions_employee_idx ON push_subscriptions (business, employee_id, active)`;
      await sql`CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions (owner_email, active)`;
      await sql`
        CREATE TABLE IF NOT EXISTS push_delivery_log (
          id UUID PRIMARY KEY,
          subscription_id UUID REFERENCES push_subscriptions(id) ON DELETE SET NULL,
          category TEXT NOT NULL DEFAULT 'message',
          title TEXT NOT NULL,
          destination_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('Delivered', 'Failed', 'Expired')),
          response_status INTEGER,
          error TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS push_delivery_log_created_idx ON push_delivery_log (created_at DESC)`;
    })().catch((error) => {
      pushSchemaPromise = null;
      throw error;
    });
  }
  return pushSchemaPromise;
}

function actorClause(actor: PushActor) {
  return actor.type === "owner"
    ? { audienceType: "owner", ownerEmail: actor.email.toLowerCase(), employeeId: null, business: null }
    : { audienceType: "employee", ownerEmail: "", employeeId: actor.employeeId, business: actor.business };
}

export async function pushPublicKey(): Promise<string> {
  return base64url((await pushKeys()).publicKey);
}

export async function pushStatus(actor: PushActor) {
  await ensurePushSchema();
  const identity = actorClause(actor);
  const rows = actor.type === "owner"
    ? await getSql()`SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE audience_type = 'owner' AND LOWER(owner_email) = LOWER(${identity.ownerEmail}) AND active = TRUE`
    : await getSql()`SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE audience_type = 'employee' AND employee_id = ${identity.employeeId} AND business = ${identity.business} AND active = TRUE`;
  const count = Number((rows as unknown as Array<{ count: number }>)[0]?.count || 0);
  return { actorType: actor.type, publicKey: await pushPublicKey(), subscribedDevices: count };
}

export async function savePushSubscription(actor: PushActor, input: PushSubscriptionInput) {
  await ensurePushSchema();
  const identity = actorClause(actor);
  const endpoint = clean(input.endpoint, 2000);
  const p256dh = clean(input.keys?.p256dh, 500);
  const auth = clean(input.keys?.auth, 500);
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw new Error("Push subscription details are incomplete.");
  await getSql()`
    INSERT INTO push_subscriptions (
      id, endpoint, audience_type, owner_email, employee_id, business, p256dh, auth,
      expiration_time, user_agent, device_label, active, failure_count, last_error, updated_at
    ) VALUES (
      ${crypto.randomUUID()}, ${endpoint}, ${identity.audienceType}, ${identity.ownerEmail},
      ${identity.employeeId}, ${identity.business}, ${p256dh}, ${auth},
      ${input.expirationTime || null}, ${clean(input.userAgent, 1000)}, ${clean(input.deviceLabel, 120)},
      TRUE, 0, '', NOW()
    )
    ON CONFLICT (endpoint) DO UPDATE SET
      audience_type = EXCLUDED.audience_type,
      owner_email = EXCLUDED.owner_email,
      employee_id = EXCLUDED.employee_id,
      business = EXCLUDED.business,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      expiration_time = EXCLUDED.expiration_time,
      user_agent = EXCLUDED.user_agent,
      device_label = EXCLUDED.device_label,
      active = TRUE,
      failure_count = 0,
      last_error = '',
      updated_at = NOW()
  `;
  return pushStatus(actor);
}

export async function removePushSubscription(actor: PushActor, endpoint: string) {
  await ensurePushSchema();
  const value = clean(endpoint, 2000);
  if (actor.type === "owner") {
    await getSql()`UPDATE push_subscriptions SET active = FALSE, updated_at = NOW() WHERE endpoint = ${value} AND audience_type = 'owner' AND LOWER(owner_email) = LOWER(${actor.email})`;
  } else {
    await getSql()`UPDATE push_subscriptions SET active = FALSE, updated_at = NOW() WHERE endpoint = ${value} AND audience_type = 'employee' AND employee_id = ${actor.employeeId} AND business = ${actor.business}`;
  }
  return pushStatus(actor);
}

async function sendToSubscription(subscription: StoredSubscription, message: PushMessage) {
  const body = encryptedPayload(subscription, message);
  const { authorization } = await vapidAuthorization(subscription.endpoint);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: requestBody(body),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 201) {
    const detail = clean(await response.text().catch(() => ""), 500);
    const error = new Error(detail || `Push service returned ${response.status}.`);
    Object.assign(error, { status: response.status });
    throw error;
  }
}

async function deliver(subscriptions: StoredSubscription[], message: PushMessage) {
  await ensurePushSchema();
  let delivered = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    let status: "Delivered" | "Failed" | "Expired" = "Delivered";
    let responseStatus: number | null = null;
    let errorText = "";
    try {
      await sendToSubscription(subscription, message);
      delivered += 1;
      await getSql()`UPDATE push_subscriptions SET last_used_at = NOW(), failure_count = 0, last_error = '', updated_at = NOW() WHERE id = ${subscription.id}`;
    } catch (error) {
      failed += 1;
      responseStatus = Number((error as { status?: number }).status || 0) || null;
      errorText = clean(error instanceof Error ? error.message : error, 500);
      status = responseStatus === 404 || responseStatus === 410 ? "Expired" : "Failed";
      await getSql()`
        UPDATE push_subscriptions SET
          active = CASE WHEN ${status} = 'Expired' THEN FALSE ELSE active END,
          failure_count = failure_count + 1,
          last_error = ${errorText}, updated_at = NOW()
        WHERE id = ${subscription.id}
      `;
    }
    await getSql()`
      INSERT INTO push_delivery_log (id, subscription_id, category, title, destination_url, status, response_status, error)
      VALUES (${crypto.randomUUID()}, ${subscription.id}, ${clean(message.category || "message", 60)}, ${clean(message.title, 200)}, ${clean(message.url, 1000)}, ${status}, ${responseStatus}, ${errorText})
    `;
  }
  return { attempted: subscriptions.length, delivered, failed };
}

async function ownerSubscriptions(): Promise<StoredSubscription[]> {
  await ensurePushSchema();
  return await getSql()`
    SELECT id, endpoint, p256dh, auth FROM push_subscriptions
    WHERE audience_type = 'owner' AND active = TRUE
    ORDER BY updated_at DESC
  ` as unknown as StoredSubscription[];
}

async function employeeSubscriptions(input: { business: Business; recipientEmployeeId?: string | null; excludeEmployeeId?: string | null }): Promise<StoredSubscription[]> {
  await ensurePushSchema();
  if (input.recipientEmployeeId) {
    return await getSql()`
      SELECT id, endpoint, p256dh, auth FROM push_subscriptions
      WHERE audience_type = 'employee' AND business = ${input.business}
        AND employee_id = ${input.recipientEmployeeId} AND active = TRUE
      ORDER BY updated_at DESC
    ` as unknown as StoredSubscription[];
  }
  return await getSql()`
    SELECT id, endpoint, p256dh, auth FROM push_subscriptions
    WHERE audience_type = 'employee' AND business = ${input.business}
      AND active = TRUE
      AND (${input.excludeEmployeeId || null}::uuid IS NULL OR employee_id <> ${input.excludeEmployeeId || null}::uuid)
    ORDER BY updated_at DESC
  ` as unknown as StoredSubscription[];
}

function senderLabel(value: string): string {
  const text = clean(value, 120);
  if (!text) return "Corner Ops";
  if (text.includes("@")) {
    const first = text.split("@")[0].split(/[._-]/)[0];
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : "Corner Ops";
  }
  return text.split(/\s+/)[0] || "Corner Ops";
}

export async function notifyEmployeesOfOwnerMessage(input: {
  business: Business;
  recipientEmployeeId?: string | null;
  body: string;
  actor: string;
}) {
  const subscriptions = await employeeSubscriptions({
    business: input.business,
    recipientEmployeeId: input.recipientEmployeeId,
  });
  return deliver(subscriptions, {
    title: input.recipientEmployeeId ? `Message from ${senderLabel(input.actor)}` : `${input.business} announcement`,
    body: clean(input.body, 220),
    url: "/employee#messages",
    tag: input.recipientEmployeeId ? `direct-owner-${input.recipientEmployeeId}` : `announcement-${input.business}`,
    category: "message",
    business: input.business,
  });
}

export async function notifyRecipientsOfEmployeeMessage(input: {
  business: Business;
  senderEmployeeId: string;
  recipientEmployeeId?: string | null;
  body: string;
  hasPhoto?: boolean;
}) {
  await ensurePushSchema();
  const senderRows = await getSql()`SELECT name FROM employees WHERE id = ${input.senderEmployeeId} AND business = ${input.business} LIMIT 1` as unknown as Array<{ name: string }>;
  const sender = senderRows[0]?.name || "Employee";
  const body = clean(input.body, 220) || (input.hasPhoto ? "Sent a photo." : "Sent a new message.");
  const [owners, employees] = await Promise.all([
    ownerSubscriptions(),
    employeeSubscriptions({
      business: input.business,
      recipientEmployeeId: input.recipientEmployeeId,
      excludeEmployeeId: input.senderEmployeeId,
    }),
  ]);
  const ownerResult = await deliver(owners, {
    title: `${input.business}: message from ${senderLabel(sender)}`,
    body,
    url: `/ops/messages?business=${encodeURIComponent(input.business)}`,
    tag: `owner-message-${input.business}`,
    category: "message",
    business: input.business,
  });
  const employeeResult = await deliver(employees, {
    title: input.recipientEmployeeId ? `Message from ${senderLabel(sender)}` : `${input.business} team message`,
    body,
    url: "/employee#messages",
    tag: input.recipientEmployeeId ? `employee-direct-${input.recipientEmployeeId}` : `employee-team-${input.business}`,
    category: "message",
    business: input.business,
  });
  return {
    attempted: ownerResult.attempted + employeeResult.attempted,
    delivered: ownerResult.delivered + employeeResult.delivered,
    failed: ownerResult.failed + employeeResult.failed,
  };
}

export async function sendTestPush(actor: PushActor) {
  await ensurePushSchema();
  const subscriptions = actor.type === "owner"
    ? await getSql()`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE audience_type = 'owner' AND LOWER(owner_email) = LOWER(${actor.email}) AND active = TRUE` as unknown as StoredSubscription[]
    : await getSql()`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE audience_type = 'employee' AND employee_id = ${actor.employeeId} AND business = ${actor.business} AND active = TRUE` as unknown as StoredSubscription[];
  return deliver(subscriptions, {
    title: "Corner Ops notifications are working",
    body: actor.type === "owner" ? "Owner messages and operational alerts can reach this device." : "Messages and employee alerts can reach this device.",
    url: actor.type === "owner" ? "/ops/messages" : "/employee",
    tag: `push-test-${actor.type}`,
    category: "test",
    business: actor.type === "employee" ? actor.business : undefined,
  });
}

export type { PushActor, PushSubscriptionInput };
