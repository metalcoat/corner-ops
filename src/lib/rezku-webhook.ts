import { Resend } from "resend";

type RezkuReceivedEvent = {
  type: string;
  data?: {
    email_id?: string;
  };
};

export type VerifiedRezkuWebhook = {
  webhookId: string;
  eventType: string;
  emailId: string;
};

export function verifyRezkuWebhook(input: {
  payload: string;
  id: string;
  timestamp: string;
  signature: string;
}): VerifiedRezkuWebhook {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!apiKey || !webhookSecret) throw new Error("Resend inbound email is not configured.");
  const resend = new Resend(apiKey);
  const event = resend.webhooks.verify({
    payload: input.payload,
    headers: { id: input.id, timestamp: input.timestamp, signature: input.signature },
    webhookSecret,
  }) as RezkuReceivedEvent;
  const emailId = String(event.data?.email_id || "").trim();
  if (event.type === "email.received" && !emailId) {
    throw new Error("Resend email.received event did not include an email ID.");
  }
  return {
    webhookId: input.id,
    eventType: event.type,
    emailId,
  };
}
