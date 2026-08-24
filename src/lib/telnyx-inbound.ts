import { createPublicKey, verify } from "node:crypto";
import { getSql } from "@/lib/db";
import { normalizeSmsPhone } from "@/lib/phone";
import type { Business } from "@/lib/types";

const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function webhookPublicKey() {
  const configured = process.env.TELNYX_PUBLIC_KEY?.trim();
  if (!configured) throw new Error("TELNYX_PUBLIC_KEY is required for inbound SMS consent webhooks.");
  if (configured.includes("BEGIN PUBLIC KEY")) return createPublicKey(configured);
  const raw = Buffer.from(configured, "base64");
  if (raw.length !== 32) throw new Error("TELNYX_PUBLIC_KEY must be a PEM key or the 32-byte base64 Ed25519 public key.");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function verifyTelnyxWebhook(rawBody: string, signature: string, timestamp: string): boolean {
  if (!signature || !timestamp) return false;
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - numericTimestamp);
  if (ageSeconds > MAX_WEBHOOK_AGE_SECONDS) return false;
  try {
    return verify(
      null,
      Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
      webhookPublicKey(),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

type TelnyxEvent = {
  data?: {
    id?: string;
    event_type?: string;
    payload?: Record<string, unknown>;
  };
};

function inboundDetails(event: TelnyxEvent) {
  const data = event.data || {};
  const payload = data.payload || {};
  const fromValue = payload.from;
  const from = typeof fromValue === "object" && fromValue && !Array.isArray(fromValue)
    ? (fromValue as Record<string, unknown>).phone_number
    : fromValue;
  return {
    eventType: clean(data.event_type, 120),
    providerMessageId: clean(data.id || (payload as Record<string, unknown>).id, 200),
    from: clean(from, 80),
    text: clean(payload.text || payload.body, 1000),
  };
}

function keywordType(text: string): { type: "Opt In" | "Opt Out" | "Help"; keyword: string } | null {
  const keyword = text.trim().toUpperCase().split(/\s+/)[0] || "";
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) return { type: "Opt Out", keyword };
  if (["START", "UNSTOP", "YES"].includes(keyword)) return { type: "Opt In", keyword };
  if (["HELP", "INFO"].includes(keyword)) return { type: "Help", keyword };
  return null;
}

export async function processTelnyxInbound(rawBody: string) {
  const event = JSON.parse(rawBody) as TelnyxEvent;
  const inbound = inboundDetails(event);
  if (inbound.eventType && inbound.eventType !== "message.received") {
    return { ignored: true, reason: `Ignoring ${inbound.eventType}.` };
  }
  const consent = keywordType(inbound.text);
  if (!consent) return { ignored: true, reason: "Inbound message was not a consent keyword." };
  let normalized = "";
  try { normalized = normalizeSmsPhone(inbound.from); } catch { normalized = ""; }
  if (!normalized) return { ignored: true, reason: "Inbound message did not include a usable sender phone." };
  const digits = normalized.replace(/\D/g, "").slice(-10);
  const employees = await getSql()`
    SELECT id, business, phone
    FROM employees
    WHERE active = TRUE AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = ${digits}
    ORDER BY business, id
  ` as unknown as Array<{ id: string; business: Business; phone: string }>;
  let updated = 0;
  for (const employee of employees) {
    if (consent.type === "Opt Out") {
      await getSql()`
        UPDATE employees SET sms_opt_in = FALSE, sms_opted_out_at = NOW(),
          sms_consent_updated_at = NOW(), updated_at = NOW()
        WHERE id = ${employee.id} AND business = ${employee.business}
      `;
      updated += 1;
    } else if (consent.type === "Opt In") {
      await getSql()`
        UPDATE employees SET sms_opt_in = TRUE, sms_opted_out_at = NULL,
          sms_consent_updated_at = NOW(), updated_at = NOW()
        WHERE id = ${employee.id} AND business = ${employee.business}
      `;
      updated += 1;
    }
    await getSql()`
      INSERT INTO sms_consent_events (
        id, business, employee_id, phone, event_type, keyword, provider_message_id, payload
      ) VALUES (
        ${crypto.randomUUID()}, ${employee.business}, ${employee.id}, ${normalized},
        ${consent.type}, ${consent.keyword}, ${inbound.providerMessageId}, ${rawBody}::jsonb
      )
      ON CONFLICT (provider_message_id) WHERE provider_message_id <> '' DO NOTHING
    `;
  }
  return { ignored: false, consent: consent.type, keyword: consent.keyword, matchedEmployees: employees.length, updated };
}
