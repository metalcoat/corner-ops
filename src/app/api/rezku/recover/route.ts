import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RECOVERY_KEY = "seLte7J_-sKecMN1sBN-O6vJerEtrIfX9T3XgLTNPuo";
const REZKU_SUBJECT = "Corner Deli Daily Reports";
const REZKU_SENDER = "support@rezku.com";

type ReceivedEmailSummary = {
  id: string;
  from?: string;
  subject?: string;
  created_at?: string;
};

type WebhookSummary = {
  id: string;
  endpoint?: string;
  status?: string;
  events?: string[];
};

function senderAddress(value: unknown) {
  return String(value ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
}

function listItems<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: T[] }).data;
  }
  return [];
}

async function runRecovery(request: Request) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "RESEND_API_KEY is not configured." }, { status: 503 });

  const resend = new Resend(apiKey);
  const origin = new URL(request.url).origin;
  const endpoint = `${origin}/api/rezku/inbound`;

  const webhookResult = await resend.webhooks.list();
  if (webhookResult.error) throw new Error(webhookResult.error.message);
  const webhooks = listItems<WebhookSummary>(webhookResult.data);
  const webhook = webhooks.find((item) => {
    try {
      return new URL(String(item.endpoint || "")).pathname === "/api/rezku/inbound";
    } catch {
      return false;
    }
  });
  if (!webhook) throw new Error("The Rezku Resend webhook could not be found.");

  let webhookReenabled = false;
  if (webhook.status !== "enabled" || webhook.endpoint !== endpoint) {
    const updated = await resend.webhooks.update(webhook.id, {
      endpoint,
      events: ["email.received"],
      status: "enabled",
    });
    if (updated.error) throw new Error(updated.error.message);
    webhookReenabled = true;
  }

  const receivingResult = await resend.emails.receiving.list();
  if (receivingResult.error) throw new Error(receivingResult.error.message);
  const received = listItems<ReceivedEmailSummary>(receivingResult.data)
    .filter((email) => senderAddress(email.from) === REZKU_SENDER && email.subject === REZKU_SUBJECT)
    .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")));

  const ids = received.map((email) => email.id).filter(Boolean);
  const existingRows = ids.length
    ? await getSql()`SELECT email_id FROM rezku_inbound_emails WHERE email_id = ANY(${ids}::text[])`
    : [];
  const existing = new Set((existingRows as unknown as Array<{ email_id: string }>).map((row) => row.email_id));
  const missing = received.filter((email) => !existing.has(email.id));

  const recovered: Array<Record<string, unknown>> = [];
  for (const email of missing) {
    const result = await retryRezkuInboundEmail(email.id, "one-time disabled webhook recovery");
    recovered.push({
      emailId: email.id,
      createdAt: email.created_at || null,
      statusCode: result.statusCode,
      payload: result.payload,
    });
  }

  return Response.json({
    ok: true,
    webhookId: webhook.id,
    webhookStatusBefore: webhook.status || null,
    webhookReenabled,
    receivedRezkuEmails: received.length,
    alreadyProcessed: received.length - missing.length,
    missingFound: missing.length,
    recovered,
  });
}

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("key") !== RECOVERY_KEY) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return runRecovery(request);
}

export async function POST(request: Request) {
  if (request.headers.get("x-recovery-key") !== RECOVERY_KEY) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return runRecovery(request);
}
