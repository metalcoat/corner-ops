import { Resend } from "resend";
import { getSql } from "@/lib/db";
import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";
import { rezkuRecoveryCandidates } from "@/lib/rezku-recovery-policy";

const REZKU_SUBJECT = "Corner Deli Daily Reports";
const REZKU_SENDER = "support@rezku.com";
const REZKU_WEBHOOK_PATH = "/api/rezku/inbound";

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

export async function repairRezkuFeed(actor: string, options: { maxEmails?: number } = {}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");

  const resend = new Resend(apiKey);
  const webhookResult = await resend.webhooks.list();
  if (webhookResult.error) throw new Error(webhookResult.error.message);

  const webhook = listItems<WebhookSummary>(webhookResult.data).find((item) => {
    try {
      return new URL(String(item.endpoint || "")).pathname === REZKU_WEBHOOK_PATH;
    } catch {
      return false;
    }
  });
  if (!webhook) throw new Error("The Rezku Resend webhook could not be found.");

  let webhookReenabled = false;
  if (webhook.status !== "enabled") {
    const updated = await resend.webhooks.update(webhook.id, {
      endpoint: webhook.endpoint || `https://corner-ops.vercel.app${REZKU_WEBHOOK_PATH}`,
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
  const trackedRows = ids.length
    ? await getSql()`
        SELECT email_id, status, updated_at
        FROM rezku_inbound_emails
        WHERE email_id = ANY(${ids}::text[])
      `
    : [];
  const tracked = (trackedRows as unknown as Array<{ email_id: string; status: string; updated_at: string }>).map((row) => ({
    emailId: row.email_id,
    status: row.status,
    updatedAt: row.updated_at,
  }));
  const maximum = options.maxEmails === undefined
    ? received.length
    : Math.max(0, Math.min(10, Math.floor(options.maxEmails)));
  const candidates = rezkuRecoveryCandidates({
    received: received.map((email) => ({ id: email.id, createdAt: email.created_at || null })),
    tracked,
    maxEmails: maximum,
  });
  const byId = new Map(received.map((email) => [email.id, email]));

  const recovered: Array<{
    emailId: string;
    createdAt: string | null;
    statusCode: number;
    processed: boolean;
    reports: number;
    failures: number;
  }> = [];

  for (const candidate of candidates) {
    const email = byId.get(candidate.id);
    if (!email) continue;
    const result = await retryRezkuInboundEmail(email.id, actor);
    const payload = result.payload as Record<string, unknown>;
    recovered.push({
      emailId: email.id,
      createdAt: email.created_at || null,
      statusCode: result.statusCode,
      processed: Boolean(payload.processed),
      reports: Array.isArray(payload.reports) ? payload.reports.length : 0,
      failures: Array.isArray(payload.failures) ? payload.failures.length : 0,
    });
  }

  const processedIds = new Set(
    tracked.filter((row) => row.status === "Processed").map((row) => row.emailId),
  );
  return {
    webhookId: webhook.id,
    webhookStatus: webhook.status || "unknown",
    webhookReenabled,
    receivedRezkuEmails: received.length,
    alreadyProcessed: received.filter((email) => processedIds.has(email.id)).length,
    recoveryCandidates: rezkuRecoveryCandidates({
      received: received.map((email) => ({ id: email.id, createdAt: email.created_at || null })),
      tracked,
      maxEmails: received.length,
    }).length,
    attempted: recovered.length,
    recovered,
  };
}
