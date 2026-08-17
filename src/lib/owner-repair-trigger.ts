import { createHash } from "node:crypto";
import { Resend } from "resend";
import { repairRezkuFeed } from "@/lib/rezku-feed-repair";
import { syncSquareConnection } from "@/lib/integrations";

const SUBJECT_PREFIX = "Corner Ops Owner Repair ";
const TOKEN_HASH = "1b8288ee42dd675ac4eabea656e0a98e642bb330e40193aa14aa378ead4ea254";

type ReceivedEvent = {
  type: string;
  data: { email_id?: string };
};

type ReceivedEmail = {
  from?: string;
  subject?: string;
};

function senderAddress(value: unknown) {
  return String(value ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
}

function tokenMatches(subject: string) {
  if (!subject.startsWith(SUBJECT_PREFIX)) return false;
  const token = subject.slice(SUBJECT_PREFIX.length).trim();
  return createHash("sha256").update(token).digest("hex") === TOKEN_HASH;
}

export async function tryOwnerRepairTrigger(request: Request): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!apiKey || !webhookSecret || !id || !timestamp || !signature) return false;

  const resend = new Resend(apiKey);
  let event: ReceivedEvent;
  try {
    const payload = await request.text();
    event = resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret }) as ReceivedEvent;
  } catch {
    return false;
  }

  if (event.type !== "email.received" || !event.data.email_id) return false;
  const received = await resend.emails.receiving.get(event.data.email_id);
  if (received.error || !received.data) return false;
  const email = received.data as ReceivedEmail;
  const owner = (process.env.APP_EMAIL || "crfrary@gmail.com").trim().toLowerCase();
  if (senderAddress(email.from) !== owner || !tokenMatches(String(email.subject || ""))) return false;

  const rezku = await repairRezkuFeed(owner);
  const square = await syncSquareConnection();
  console.log("[owner-repair] completed", { rezku, square });
  return true;
}
