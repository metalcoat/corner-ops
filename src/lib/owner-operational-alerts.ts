import {
  createCipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { ensurePushSchema } from "@/lib/push-notifications";
import type { Business } from "@/lib/types";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const PUSH_SUBJECT = process.env.PUSH_SUBJECT?.trim() || "mailto:crfrary@gmail.com";

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type AlertInput = {
  business: Business;
  title: string;
  body: string;
  url: string;
  tag: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function pushKeys() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required before push notifications can be used.");
  const digest = createHash("sha256").update(`corner-ops-web-push-v1:${secret}`).digest();
  let scalar = BigInt(`0x${digest.toString("hex")}`);
  scalar = (scalar % (P256_ORDER - 1n)) + 1n;
  const privateKey = Buffer.from(scalar.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  return { privateKey, publicKey: ecdh.getPublicKey(undefined, "uncompressed") };
}

function hmac(key: Buffer, value: Buffer): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const parts: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(parts).length < length) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    parts.push(previous);
    counter += 1;
  }
  return Buffer.concat(parts).subarray(0, length);
}

function vapidAuthorization(endpoint: string) {
  const { privateKey, publicKey } = pushKeys();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: now + 43_200,
    sub: PUSH_SUBJECT,
  })));
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
  return `vapid t=${unsigned}.${base64url(signature)}, k=${base64url(publicKey)}`;
}

function encryptedPayload(subscription: StoredSubscription, input: AlertInput): Buffer {
  const clientPublicKey = decodeBase64url(subscription.p256dh);
  const authSecret = decodeBase64url(subscription.auth);
  if (clientPublicKey.length !== 65 || !authSecret.length) throw new Error("Push subscription keys are invalid.");

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
  const message = Buffer.from(JSON.stringify({
    title: clean(input.title, 180),
    body: clean(input.body, 500),
    url: clean(input.url, 1000),
    tag: clean(input.tag, 180),
    category: "overtime",
    business: input.business,
  }), "utf8");
  const plaintext = Buffer.concat([message, Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublicKey.length]), serverPublicKey, ciphertext]);
}

async function sendPush(subscription: StoredSubscription, input: AlertInput) {
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body: encryptedPayload(subscription, input),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 201) {
    const error = new Error(clean(await response.text().catch(() => ""), 500) || `Push service returned ${response.status}.`);
    Object.assign(error, { status: response.status });
    throw error;
  }
}

async function deliverPush(input: AlertInput) {
  await ensurePushSchema();
  const subscriptions = await getSql()`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE audience_type = 'owner' AND active = TRUE
    ORDER BY updated_at DESC
  ` as unknown as StoredSubscription[];
  let delivered = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    let status: "Delivered" | "Failed" | "Expired" = "Delivered";
    let responseStatus: number | null = null;
    let errorText = "";
    try {
      await sendPush(subscription, input);
      delivered += 1;
      await getSql()`
        UPDATE push_subscriptions
        SET last_used_at = NOW(), failure_count = 0, last_error = '', updated_at = NOW()
        WHERE id = ${subscription.id}
      `;
    } catch (error) {
      failed += 1;
      responseStatus = Number((error as { status?: number }).status || 0) || null;
      errorText = clean(error instanceof Error ? error.message : error, 500);
      status = responseStatus === 404 || responseStatus === 410 ? "Expired" : "Failed";
      await getSql()`
        UPDATE push_subscriptions SET
          active = CASE WHEN ${status} = 'Expired' THEN FALSE ELSE active END,
          failure_count = failure_count + 1,
          last_error = ${errorText},
          updated_at = NOW()
        WHERE id = ${subscription.id}
      `;
    }
    await getSql()`
      INSERT INTO push_delivery_log (
        id, subscription_id, category, title, destination_url, status, response_status, error
      ) VALUES (
        ${crypto.randomUUID()}, ${subscription.id}, 'overtime', ${clean(input.title, 200)},
        ${clean(input.url, 1000)}, ${status}, ${responseStatus}, ${errorText}
      )
    `;
  }
  return { attempted: subscriptions.length, delivered, failed };
}

async function deliverEmail(input: AlertInput) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.ALERT_FROM_EMAIL?.trim();
  const to = process.env.ALERT_TO_EMAIL?.trim() || process.env.APP_EMAIL?.trim();
  if (!apiKey || !from || !to) return { configured: false, sent: false };
  const base = process.env.APP_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const pageUrl = base
    ? `${base.startsWith("http") ? base : `https://${base}`}${input.url}`
    : input.url;
  const result = await new Resend(apiKey).emails.send({
    from,
    to,
    subject: input.title,
    text: `${input.body}\n\nReview overtime risk: ${pageUrl}`,
  });
  if (result.error) throw new Error(result.error.message);
  return { configured: true, sent: true, id: result.data?.id || null };
}

export async function notifyOwnersOfOperationalAlert(input: AlertInput) {
  const [push, email] = await Promise.all([
    deliverPush(input).catch((error) => ({
      attempted: 0,
      delivered: 0,
      failed: 1,
      error: error instanceof Error ? error.message : String(error),
    })),
    deliverEmail(input).catch((error) => ({
      configured: true,
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);
  return { ...push, email };
}
