import { Resend } from "resend";
import { processAttendanceReply } from "@/lib/attendance";
import { importRezkuReport } from "@/lib/operations";

export const runtime = "nodejs";

type ReceivedEvent = {
  type: string;
  data: {
    email_id: string;
    from?: string;
    to?: string[];
    subject?: string;
  };
};

type ReceivedEmail = {
  from?: string;
  to?: string[];
  subject?: string;
  html?: string | null;
  text?: string | null;
};

type ReceivingAttachment = {
  filename: string;
  download_url: string;
};

const REZKU_SUBJECT = "Corner Deli Daily Reports";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";

function reportType(fileName: string): "shifts" | "orders" | "transactions" | undefined {
  const lower = fileName.toLowerCase();
  if (lower.includes("labor") || lower.includes("shift") || lower.includes("attestation")) return "shifts";
  if (lower.includes("transaction") || lower.includes("payment")) return "transactions";
  if (lower.includes("order")) return "orders";
  return undefined;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function htmlText(value: string): string {
  return decodeHtml(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function senderAddress(value: string): string {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
}

function excelLinks(content: string): Array<{ url: string; fileName: string }> {
  const matches = decodeHtml(content).match(/https:\/\/[^\s"'<>]+?\.(?:xlsx|xls)(?:\?[^\s"'<>]*)?/gi) || [];
  const unique = new Map<string, { url: string; fileName: string }>();
  for (const rawUrl of matches) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST) continue;
      const fileName = url.pathname.split("/").pop() || "rezku-report.xlsx";
      unique.set(url.toString(), { url: url.toString(), fileName });
    } catch {
      // Ignore malformed links from the email body.
    }
  }
  return [...unique.values()];
}

function attachmentList(value: unknown): ReceivingAttachment[] {
  if (Array.isArray(value)) return value as ReceivingAttachment[];
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: ReceivingAttachment[] }).data;
  }
  return [];
}

async function downloadAndImport(url: string, fileName: string, importedBy: string) {
  const download = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!download.ok) throw new Error(`Rezku download failed for ${fileName}: HTTP ${download.status}`);
  const result = await importRezkuReport(fileName, await download.arrayBuffer(), reportType(fileName), importedBy);
  return { fileName, reportType: result.reportType, rowsRead: result.rowsRead, imported: result.imported };
}

export async function POST(request: Request) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!apiKey || !webhookSecret) {
    return Response.json({ error: "Resend inbound email is not configured." }, { status: 503 });
  }

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return Response.json({ error: "Missing webhook signature headers." }, { status: 400 });
  }

  const resend = new Resend(apiKey);
  const payload = await request.text();
  let event: ReceivedEvent;
  try {
    event = resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret }) as ReceivedEvent;
  } catch {
    return Response.json({ error: "Invalid webhook signature." }, { status: 400 });
  }

  if (event.type !== "email.received") {
    return Response.json({ ignored: true, reason: "Not an inbound email event." });
  }

  const { data: emailData, error: emailError } = await resend.emails.receiving.get(event.data.email_id);
  if (emailError || !emailData) {
    return Response.json({ error: emailError?.message || "Received email could not be retrieved." }, { status: 502 });
  }

  const email = emailData as ReceivedEmail;
  const sender = email.from || event.data.from || "";
  const recipients = email.to || event.data.to || [];
  const subject = email.subject || event.data.subject || "";
  const text = email.text || htmlText(email.html || "");

  const attendance = await processAttendanceReply({ recipients, from: sender, text, subject });
  if (attendance.handled) {
    return Response.json({ processed: true, kind: "attendance-reply", emailId: event.data.email_id, ...attendance });
  }

  const allowedSender = (process.env.REZKU_ALLOWED_SENDER?.trim() || "support@rezku.com").toLowerCase();
  if (senderAddress(sender) !== allowedSender || subject !== REZKU_SUBJECT) {
    return Response.json({ ignored: true, reason: "Email did not match an attendance reply or the trusted Rezku sender and subject." });
  }

  const sources = excelLinks(`${email.html || ""}\n${email.text || ""}`);
  const { data: rawAttachments, error: attachmentError } = await resend.emails.receiving.attachments.list({ emailId: event.data.email_id });
  if (attachmentError) return Response.json({ error: attachmentError.message }, { status: 502 });

  for (const attachment of attachmentList(rawAttachments)) {
    if (!/\.(xlsx|xls)$/i.test(attachment.filename)) continue;
    sources.push({ url: attachment.download_url, fileName: attachment.filename });
  }

  const uniqueSources = [...new Map(sources.map((source) => [source.url, source])).values()];
  if (uniqueSources.length === 0) {
    return Response.json({ error: "The Rezku email did not contain any Excel report links." }, { status: 422 });
  }

  const results = [];
  for (const source of uniqueSources) {
    results.push(await downloadAndImport(source.url, source.fileName, `Resend inbound ${event.data.email_id}`));
  }

  return Response.json({ processed: true, kind: "rezku-reports", emailId: event.data.email_id, webhookId: id, reports: results });
}
