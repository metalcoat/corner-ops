import { Resend } from "resend";
import { importRezkuReport } from "@/lib/operations";
import {
  detectRezkuVoidReportType,
  importRezkuVoidReport,
  type RezkuVoidReportType,
} from "@/lib/rezku-voids";
import {
  finishRezkuInboundEmail,
  recordRezkuInboundReport,
  startRezkuInboundEmail,
} from "@/lib/rezku-monitor";

export const runtime = "nodejs";

type StandardReportType = "shifts" | "orders" | "transactions";
type ReportType = StandardReportType | RezkuVoidReportType;

type ReceivedEvent = {
  type: string;
  data: {
    email_id: string;
    from?: string;
    subject?: string;
  };
};

type ReceivedEmail = {
  from?: string;
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

function reportType(fileName: string): ReportType | undefined {
  const voidType = detectRezkuVoidReportType(fileName);
  if (voidType) return voidType;
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

function senderAddress(value: string): string {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
}

function reportDate(content: string): string | null {
  const match = decodeHtml(content).match(/overview of your day,\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} 12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
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
  const bytes = await download.arrayBuffer();
  const kind = reportType(fileName);
  const result = kind === "product_voids" || kind === "transaction_voids"
    ? await importRezkuVoidReport(fileName, bytes, kind, importedBy)
    : await importRezkuReport(fileName, bytes, kind, importedBy);
  return {
    fileName,
    batchId: result.batchId,
    reportType: result.reportType,
    rowsRead: result.rowsRead,
    imported: result.imported,
  };
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
  const subject = email.subject || event.data.subject || "";
  const allowedSender = (process.env.REZKU_ALLOWED_SENDER?.trim() || "support@rezku.com").toLowerCase();
  if (senderAddress(sender) !== allowedSender || subject !== REZKU_SUBJECT) {
    return Response.json({ ignored: true, reason: "Email did not match the trusted Rezku sender and subject." });
  }

  const content = `${email.html || ""}\n${email.text || ""}`;
  const sources = excelLinks(content);
  const emailReportDate = reportDate(content);

  const { data: rawAttachments, error: attachmentError } = await resend.emails.receiving.attachments.list({ emailId: event.data.email_id });
  if (attachmentError) {
    await startRezkuInboundEmail({
      emailId: event.data.email_id,
      webhookId: id,
      sender,
      subject,
      reportDate: emailReportDate,
      reportsFound: sources.length,
    });
    await finishRezkuInboundEmail({
      emailId: event.data.email_id,
      status: "Failed",
      reportsProcessed: 0,
      error: attachmentError.message,
    });
    return Response.json({ error: attachmentError.message }, { status: 502 });
  }

  for (const attachment of attachmentList(rawAttachments)) {
    if (!/\.(xlsx|xls)$/i.test(attachment.filename)) continue;
    sources.push({ url: attachment.download_url, fileName: attachment.filename });
  }

  const uniqueSources = [...new Map(sources.map((source) => [source.url, source])).values()];
  await startRezkuInboundEmail({
    emailId: event.data.email_id,
    webhookId: id,
    sender,
    subject,
    reportDate: emailReportDate,
    reportsFound: uniqueSources.length,
  });

  if (uniqueSources.length === 0) {
    const error = "The Rezku email did not contain any Excel report links.";
    await finishRezkuInboundEmail({ emailId: event.data.email_id, status: "Failed", reportsProcessed: 0, error });
    return Response.json({ error }, { status: 422 });
  }

  const results: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const source of uniqueSources) {
    const kind = reportType(source.fileName) || "";
    await recordRezkuInboundReport({
      emailId: event.data.email_id,
      fileName: source.fileName,
      reportType: kind,
      status: "Processing",
    });
    try {
      const result = await downloadAndImport(source.url, source.fileName, `Resend inbound ${event.data.email_id}`);
      results.push(result);
      await recordRezkuInboundReport({
        emailId: event.data.email_id,
        fileName: source.fileName,
        reportType: result.reportType,
        status: "Processed",
        batchId: result.batchId,
        rowsRead: result.rowsRead,
        rowsImported: result.imported,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${source.fileName}: ${message}`);
      await recordRezkuInboundReport({
        emailId: event.data.email_id,
        fileName: source.fileName,
        reportType: kind,
        status: "Failed",
        error: message,
      });
    }
  }

  const successful = results.length;
  const status = failures.length === 0 ? "Processed" : successful > 0 ? "Partial" : "Failed";
  await finishRezkuInboundEmail({
    emailId: event.data.email_id,
    status,
    reportsProcessed: successful,
    error: failures.join("\n"),
  });

  const response = {
    processed: failures.length === 0,
    kind: "rezku-reports",
    emailId: event.data.email_id,
    webhookId: id,
    reportDate: emailReportDate,
    reports: results,
    failures,
  };
  return Response.json(response, { status: failures.length ? 500 : 200 });
}
