import { Resend } from "resend";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
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
export const dynamic = "force-dynamic";

type StandardReportType = "shifts" | "orders" | "transactions";
type ReportType = StandardReportType | RezkuVoidReportType;
type ReportSource = {
  url: string;
  fileName: string;
  source: "email-link" | "attachment";
};

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

function cleanFileName(value: string): string {
  const last = value.split("/").pop() || "rezku-report.xlsx";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function sourceKey(fileName: string): string {
  return cleanFileName(fileName).trim().toLowerCase();
}

function excelLinks(content: string): ReportSource[] {
  const matches = decodeHtml(content).match(/https:\/\/[^\s"'<>]+?\.(?:xlsx|xls)(?:\?[^\s"'<>]*)?/gi) || [];
  const unique = new Map<string, ReportSource>();
  for (const rawUrl of matches) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST) continue;
      const fileName = cleanFileName(url.pathname);
      unique.set(url.toString(), { url: url.toString(), fileName, source: "email-link" });
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

function preferredSources(emailLinks: ReportSource[], attachments: ReceivingAttachment[]): ReportSource[] {
  const byFileName = new Map<string, ReportSource>();

  for (const source of emailLinks) {
    byFileName.set(sourceKey(source.fileName), source);
  }

  // Resend attachment URLs are generated for the received message and are more reliable
  // than the duplicate, expiring Rezku links embedded in the email body.
  for (const attachment of attachments) {
    if (!/\.(xlsx|xls)$/i.test(attachment.filename)) continue;
    const fileName = cleanFileName(attachment.filename);
    byFileName.set(sourceKey(fileName), {
      url: attachment.download_url,
      fileName,
      source: "attachment",
    });
  }

  return [...byFileName.values()];
}

async function downloadAndImport(url: string, fileName: string, importedBy: string) {
  const download = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!download.ok) throw new Error(`Rezku download failed for ${fileName}: HTTP ${download.status}`);
  const bytes = await download.arrayBuffer();
  const kind = reportType(fileName);
  if (kind !== "product_voids" && kind !== "transaction_voids") {
    await ensureEmployeeDirectorySchema();
  }
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

export async function GET() {
  const apiKeyConfigured = Boolean(process.env.RESEND_API_KEY?.trim());
  const webhookSecretConfigured = Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim());
  const configured = apiKeyConfigured && webhookSecretConfigured;
  return Response.json({
    ok: configured,
    service: "Rezku inbound email",
    configured: {
      resendApiKey: apiKeyConfigured,
      webhookSecret: webhookSecretConfigured,
      allowedSender: (process.env.REZKU_ALLOWED_SENDER?.trim() || "support@rezku.com").toLowerCase(),
    },
    expected: {
      event: "email.received",
      subject: REZKU_SUBJECT,
      excelHost: REZKU_FILE_HOST,
    },
  }, { status: configured ? 200 : 503 });
}

export async function POST(request: Request) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");

  console.log("[rezku/inbound] request received", {
    webhookId: id || null,
    hasTimestamp: Boolean(timestamp),
    hasSignature: Boolean(signature),
    configured: Boolean(apiKey && webhookSecret),
  });

  if (!apiKey || !webhookSecret) {
    console.error("[rezku/inbound] rejected because Resend environment variables are missing", {
      apiKeyConfigured: Boolean(apiKey),
      webhookSecretConfigured: Boolean(webhookSecret),
    });
    return Response.json({ error: "Resend inbound email is not configured." }, { status: 503 });
  }

  if (!id || !timestamp || !signature) {
    console.error("[rezku/inbound] rejected because signature headers are missing", { webhookId: id || null });
    return Response.json({ error: "Missing webhook signature headers." }, { status: 400 });
  }

  const resend = new Resend(apiKey);
  const payload = await request.text();
  let event: ReceivedEvent;
  try {
    event = resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret }) as ReceivedEvent;
  } catch (error) {
    console.error("[rezku/inbound] invalid webhook signature", {
      webhookId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Invalid webhook signature." }, { status: 400 });
  }

  console.log("[rezku/inbound] verified event", {
    webhookId: id,
    eventType: event.type,
    emailId: event.data?.email_id || null,
  });

  if (event.type !== "email.received") {
    console.log("[rezku/inbound] ignored non-email event", { webhookId: id, eventType: event.type });
    return Response.json({ ignored: true, reason: "Not an inbound email event." });
  }

  const { data: emailData, error: emailError } = await resend.emails.receiving.get(event.data.email_id);
  if (emailError || !emailData) {
    console.error("[rezku/inbound] received email could not be retrieved", {
      webhookId: id,
      emailId: event.data.email_id,
      error: emailError?.message || "No email payload returned",
    });
    return Response.json({ error: emailError?.message || "Received email could not be retrieved." }, { status: 502 });
  }

  const email = emailData as ReceivedEmail;
  const sender = email.from || event.data.from || "";
  const subject = email.subject || event.data.subject || "";
  const allowedSender = (process.env.REZKU_ALLOWED_SENDER?.trim() || "support@rezku.com").toLowerCase();
  if (senderAddress(sender) !== allowedSender || subject !== REZKU_SUBJECT) {
    console.log("[rezku/inbound] ignored unmatched email", {
      webhookId: id,
      emailId: event.data.email_id,
      sender: senderAddress(sender),
      subject,
      senderMatched: senderAddress(sender) === allowedSender,
      subjectMatched: subject === REZKU_SUBJECT,
    });
    return Response.json({ ignored: true, reason: "Email did not match the trusted Rezku sender and subject." });
  }

  const content = `${email.html || ""}\n${email.text || ""}`;
  const emailLinks = excelLinks(content);
  const emailReportDate = reportDate(content);

  const { data: rawAttachments, error: attachmentError } = await resend.emails.receiving.attachments.list({ emailId: event.data.email_id });
  if (attachmentError) {
    console.error("[rezku/inbound] attachment listing failed", {
      webhookId: id,
      emailId: event.data.email_id,
      error: attachmentError.message,
    });
    await startRezkuInboundEmail({
      emailId: event.data.email_id,
      webhookId: id,
      sender,
      subject,
      reportDate: emailReportDate,
      reportsFound: emailLinks.length,
    });
    await finishRezkuInboundEmail({
      emailId: event.data.email_id,
      status: "Failed",
      reportsProcessed: 0,
      error: attachmentError.message,
    });
    return Response.json({ error: attachmentError.message }, { status: 502 });
  }

  const attachments = attachmentList(rawAttachments);
  const uniqueSources = preferredSources(emailLinks, attachments);
  console.log("[rezku/inbound] trusted email located", {
    webhookId: id,
    emailId: event.data.email_id,
    reportDate: emailReportDate,
    reportFiles: uniqueSources.map((source) => ({ fileName: source.fileName, source: source.source })),
  });

  await startRezkuInboundEmail({
    emailId: event.data.email_id,
    webhookId: id,
    sender,
    subject,
    reportDate: emailReportDate,
    reportsFound: uniqueSources.length,
  });

  if (uniqueSources.length === 0) {
    const error = "The Rezku email did not contain any Excel report links or attachments.";
    console.error("[rezku/inbound] no Excel reports found", { webhookId: id, emailId: event.data.email_id });
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
      console.log("[rezku/inbound] report imported", {
        webhookId: id,
        emailId: event.data.email_id,
        fileName: source.fileName,
        source: source.source,
        reportType: result.reportType,
        rowsRead: result.rowsRead,
        rowsImported: result.imported,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${source.fileName}: ${message}`);
      console.error("[rezku/inbound] report import failed", {
        webhookId: id,
        emailId: event.data.email_id,
        fileName: source.fileName,
        source: source.source,
        error: message,
      });
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

  console.log("[rezku/inbound] email processing finished", {
    webhookId: id,
    emailId: event.data.email_id,
    status,
    reportsProcessed: successful,
    failures: failures.length,
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
