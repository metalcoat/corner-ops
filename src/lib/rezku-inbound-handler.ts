import { Resend } from "resend";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { importSafeRezkuReport } from "@/lib/safe-rezku-import";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";
import {
  detectRezkuProductSalesReportType,
  importRezkuProductSalesReport,
  type RezkuProductSalesReportType,
} from "@/lib/rezku-product-sales";
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

type StandardReportType = "shifts" | "orders" | "transactions";
type ReportType = StandardReportType | RezkuVoidReportType | RezkuProductSalesReportType;
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

type ProcessResult = {
  statusCode: number;
  payload: Record<string, unknown>;
};

const REZKU_SUBJECT = "Corner Deli Daily Reports";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function reportType(fileName: string): ReportType | undefined {
  const productSalesType = detectRezkuProductSalesReportType(fileName);
  if (productSalesType) return productSalesType;
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
    return decodeURIComponent(last.split("?")[0]);
  } catch {
    return last.split("?")[0];
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
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== REZKU_FILE_HOST) continue;
      const fileName = cleanFileName(parsed.pathname);
      unique.set(rawUrl, { url: rawUrl, fileName, source: "email-link" });
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
  for (const source of emailLinks) byFileName.set(sourceKey(source.fileName), source);
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
  const download = await downloadRezkuWorkbook(url, fileName);
  const kind = reportType(fileName);
  const standardReport = kind === "shifts" || kind === "orders" || kind === "transactions";
  if (standardReport) await ensureEmployeeDirectorySchema();

  const result = kind === "product_voids" || kind === "transaction_voids"
    ? await importRezkuVoidReport(fileName, download.bytes, kind, importedBy)
    : kind === "sales_by_product"
      ? await importRezkuProductSalesReport(fileName, download.bytes, kind, importedBy)
      : await importSafeRezkuReport(fileName, download.bytes, kind, importedBy);
  return {
    fileName,
    batchId: result.batchId,
    reportType: result.reportType,
    rowsRead: result.rowsRead,
    imported: result.imported,
    downloadMethod: download.method,
    contentType: download.contentType,
  };
}

async function processRezkuEmail(input: {
  emailId: string;
  webhookId: string;
  importedBy: string;
}): Promise<ProcessResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { statusCode: 503, payload: { error: "Resend inbound email is not configured." } };
  }

  const resend = new Resend(apiKey);
  const { data: emailData, error: emailError } = await resend.emails.receiving.get(input.emailId);
  if (emailError || !emailData) {
    const error = emailError?.message || "Received email could not be retrieved.";
    console.error("[rezku/inbound] received email could not be retrieved", { emailId: input.emailId, error });
    return { statusCode: 502, payload: { error } };
  }

  const email = emailData as ReceivedEmail;
  const sender = email.from || "";
  const subject = email.subject || "";
  const allowedSender = (process.env.REZKU_ALLOWED_SENDER?.trim() || "support@rezku.com").toLowerCase();
  if (senderAddress(sender) !== allowedSender || subject !== REZKU_SUBJECT) {
    return {
      statusCode: 200,
      payload: { ignored: true, reason: "Email did not match the trusted Rezku sender and subject." },
    };
  }

  const content = `${email.html || ""}\n${email.text || ""}`;
  const emailLinks = excelLinks(content);
  const emailReportDate = reportDate(content);
  const { data: rawAttachments, error: attachmentError } = await resend.emails.receiving.attachments.list({ emailId: input.emailId });

  if (attachmentError) {
    await startRezkuInboundEmail({
      emailId: input.emailId,
      webhookId: input.webhookId,
      sender,
      subject,
      reportDate: emailReportDate,
      reportsFound: emailLinks.length,
    });
    await finishRezkuInboundEmail({
      emailId: input.emailId,
      status: "Failed",
      reportsProcessed: 0,
      error: attachmentError.message,
    });
    return { statusCode: 502, payload: { error: attachmentError.message } };
  }

  const attachments = attachmentList(rawAttachments);
  const uniqueSources = preferredSources(emailLinks, attachments);
  console.log("[rezku/inbound] trusted email located", {
    webhookId: input.webhookId,
    emailId: input.emailId,
    reportDate: emailReportDate,
    reports: uniqueSources.map((source) => ({ fileName: source.fileName, source: source.source })),
  });

  await startRezkuInboundEmail({
    emailId: input.emailId,
    webhookId: input.webhookId,
    sender,
    subject,
    reportDate: emailReportDate,
    reportsFound: uniqueSources.length,
  });

  if (!uniqueSources.length) {
    const error = "The Rezku email did not contain any Excel report links or attachments.";
    await finishRezkuInboundEmail({ emailId: input.emailId, status: "Failed", reportsProcessed: 0, error });
    return { statusCode: 422, payload: { error } };
  }

  const results: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const source of uniqueSources) {
    const kind = reportType(source.fileName) || "";
    await recordRezkuInboundReport({
      emailId: input.emailId,
      fileName: source.fileName,
      reportType: kind,
      status: "Processing",
    });
    try {
      const result = await downloadAndImport(source.url, source.fileName, input.importedBy);
      results.push(result);
      await recordRezkuInboundReport({
        emailId: input.emailId,
        fileName: source.fileName,
        reportType: result.reportType,
        status: "Processed",
        batchId: result.batchId,
        rowsRead: result.rowsRead,
        rowsImported: result.imported,
      });
      console.log("[rezku/inbound] report imported", {
        webhookId: input.webhookId,
        emailId: input.emailId,
        fileName: source.fileName,
        source: source.source,
        reportType: result.reportType,
        rowsRead: result.rowsRead,
        rowsImported: result.imported,
        downloadMethod: result.downloadMethod,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${source.fileName}: ${message}`);
      console.error("[rezku/inbound] report import failed", {
        webhookId: input.webhookId,
        emailId: input.emailId,
        fileName: source.fileName,
        source: source.source,
        error: message,
      });
      await recordRezkuInboundReport({
        emailId: input.emailId,
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
    emailId: input.emailId,
    status,
    reportsProcessed: successful,
    error: failures.join("\n"),
  });

  const payload = {
    processed: failures.length === 0,
    kind: "rezku-reports",
    emailId: input.emailId,
    webhookId: input.webhookId,
    reportDate: emailReportDate,
    reports: results,
    failures,
  };
  return { statusCode: failures.length ? 502 : 200, payload };
}

export async function retryRezkuInboundEmail(emailId: string, actor: string) {
  const cleanId = clean(emailId, 180);
  if (!cleanId) throw new Error("Choose a Rezku email to retry.");
  return processRezkuEmail({
    emailId: cleanId,
    webhookId: `manual-retry-${crypto.randomUUID()}`,
    importedBy: `Rezku retry by ${clean(actor, 240)}`,
  });
}

export async function rezkuInboundGet() {
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
      edgeFallback: Boolean(process.env.CRON_SECRET?.trim()),
    },
    expected: {
      event: "email.received",
      subject: REZKU_SUBJECT,
      excelHost: REZKU_FILE_HOST,
    },
  }, { status: configured ? 200 : 503 });
}

export async function rezkuInboundPost(request: Request) {
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
    return Response.json({ error: "Resend inbound email is not configured." }, { status: 503 });
  }
  if (!id || !timestamp || !signature) {
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

  if (event.type !== "email.received") {
    return Response.json({ ignored: true, reason: "Not an inbound email event." });
  }

  const result = await processRezkuEmail({
    emailId: event.data.email_id,
    webhookId: id,
    importedBy: `Resend inbound ${event.data.email_id}`,
  });
  return Response.json(result.payload, { status: result.statusCode });
}
