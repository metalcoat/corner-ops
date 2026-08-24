import { timingSafeEqual } from "node:crypto";
import { del, put } from "@vercel/blob";
import { recordAuditEvent } from "@/lib/audit";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import { insertDocument } from "@/lib/documents";
import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, AuthenticationError } from "@/lib/http";
import { invoiceOcrConfiguration, processInvoiceDocument, type InvoiceOcrField, type InvoiceOcrResult } from "@/lib/invoice-ocr";
import { assertRateLimit, authRatePolicies, clearRateLimit, recordRateLimitFailure } from "@/lib/rate-limit";
import type { Business, DocumentStatus } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const OCR_AUTO_ACCEPT_CONFIDENCE = 0.6;
const documentTypes = ["Invoice", "Receipt", "Insurance", "Permit", "Contract", "Employee", "Inventory", "Other"] as const;
type ScanDocumentType = (typeof documentTypes)[number];

type ScannerAccess = {
  mode: "owner" | "employee" | "guest";
  business: Business;
  actor: string;
  status: DocumentStatus;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Choose Corner Deli or Tiki.");
}

function documentTypeFrom(value: unknown): ScanDocumentType {
  return documentTypes.includes(value as ScanDocumentType) ? value as ScanDocumentType : "Other";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function guestPinFor(business: Business): string {
  const name = business === "Corner Deli" ? "DOCUMENT_UPLOAD_PIN_CORNER_DELI" : "DOCUMENT_UPLOAD_PIN_TIKI";
  return process.env[name]?.trim() || "";
}

function safePart(value: string, fallback = "document"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return normalized || fallback;
}

function validDate(value: unknown): string {
  const text = clean(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function categoryFor(type: ScanDocumentType): string {
  if (type === "Invoice" || type === "Receipt") return "Financial";
  if (type === "Insurance" || type === "Permit") return "Compliance";
  if (type === "Contract") return "Vendor";
  if (type === "Employee") return "Employee";
  if (type === "Inventory") return "Inventory";
  return "General";
}

function titleFor(input: {
  type: ScanDocumentType;
  manualTitle: string;
  vendor: string;
  reference: string;
}): string {
  if (input.manualTitle) return input.manualTitle;
  const party = input.vendor || (input.type === "Receipt" ? "Merchant" : input.type === "Invoice" ? "Vendor" : input.type);
  if (input.type === "Invoice") return `${party} Invoice${input.reference ? ` ${input.reference}` : ""}`;
  if (input.type === "Receipt") return `${party} Receipt${input.reference ? ` ${input.reference}` : ""}`;
  if (input.type === "Insurance") return `${party} Insurance Document`;
  if (input.type === "Permit") return `${party} Permit`;
  if (input.type === "Contract") return `${party} Contract`;
  if (input.type === "Employee") return `${party} Employee Document`;
  if (input.type === "Inventory") return `${party} Inventory Document`;
  return `${party} Document`;
}

function fileNameFor(input: {
  business: Business;
  type: ScanDocumentType;
  documentDate: string;
  vendor: string;
  reference: string;
  title: string;
}): string {
  const pieces = [
    input.documentDate,
    safePart(input.business),
    safePart(input.type),
    safePart(input.vendor || input.title),
    input.reference ? safePart(input.reference) : "",
  ].filter(Boolean);
  return `${pieces.join("-")}.jpg`;
}

async function resolveAccess(business: Business, suppliedPin: string, request: Request): Promise<ScannerAccess> {
  const [owner, employee] = await Promise.all([getSession(), getEmployeeSession()]);
  if (owner && canAccessBusiness(owner, business)) {
    return { mode: "owner", business, actor: owner.email, status: "Active" };
  }
  if (employee) {
    if (employee.business !== business) throw new AuthenticationError("Employee scanner access is limited to the employee's business.");
    return { mode: "employee", business, actor: `Employee: ${employee.name}`, status: "Needs Review" };
  }

  const policies = authRatePolicies("document-upload-pin", request, business);
  await assertRateLimit(policies);
  const expectedPin = guestPinFor(business);
  if (!expectedPin || !suppliedPin || !safeEqual(expectedPin, suppliedPin)) {
    await recordRateLimitFailure(policies);
    throw new AuthenticationError("A valid employee session, owner session, or document upload PIN is required.");
  }
  await clearRateLimit(policies);
  return { mode: "guest", business, actor: "External document uploader", status: "Needs Review" };
}

function confidentValue<T>(field: InvoiceOcrField<T> | undefined, fallback: T): T {
  return field && field.confidence >= OCR_AUTO_ACCEPT_CONFIDENCE ? field.value : fallback;
}

function ocrNotes(result: InvoiceOcrResult | null): string[] {
  if (!result) return [];
  const notes = [
    `OCR provider: ${result.provider} (${Math.round(result.overallConfidence * 100)}% confidence).`,
  ];
  if (result.fields.vendor.value) notes.push(`Detected vendor: ${result.fields.vendor.value}.`);
  if (result.fields.invoiceNumber.value) notes.push(`Detected reference: ${result.fields.invoiceNumber.value}.`);
  if (result.fields.totalAmount.value) notes.push(`Detected total: $${result.fields.totalAmount.value.toFixed(2)}.`);
  if (result.warnings.length) notes.push(`OCR warnings: ${result.warnings.join(" ")}`);
  return notes;
}

export async function GET() {
  try {
    const [owner, employee] = await Promise.all([getSession(), getEmployeeSession()]);
    if (owner) {
      return Response.json({
        mode: "owner",
        name: owner.displayName || owner.email,
        businesses: owner.businesses,
        guestEnabled: {
          "Corner Deli": Boolean(guestPinFor("Corner Deli")),
          Tiki: Boolean(guestPinFor("Tiki")),
        },
        ocr: invoiceOcrConfiguration(),
      });
    }
    if (employee) {
      return Response.json({
        mode: "employee",
        name: employee.name,
        business: employee.business,
        businesses: [employee.business],
        guestEnabled: false,
        ocr: invoiceOcrConfiguration(),
      });
    }
    return Response.json({
      mode: "guest",
      name: "Document uploader",
      businesses: ["Corner Deli", "Tiki"],
      guestEnabled: {
        "Corner Deli": Boolean(guestPinFor("Corner Deli")),
        Tiki: Boolean(guestPinFor("Tiki")),
      },
      ocr: invoiceOcrConfiguration(),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl: string | null = null;
  try {
    assertConfigured("DATABASE_URL", "BLOB_READ_WRITE_TOKEN");
    const form = await request.formData();
    const business = businessFrom(form.get("business"));
    const access = await resolveAccess(business, clean(form.get("uploadPin"), 120), request);
    const type = documentTypeFrom(form.get("documentType"));
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      return Response.json({ error: "Take or choose a document photo first." }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: "Scanned documents are limited to 15 MB." }, { status: 413 });
    }
    if (!/\.(jpg|jpeg|png|webp)$/i.test(file.name) && !/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      return Response.json({ error: "The mobile scanner accepts JPG, PNG, or WebP images." }, { status: 415 });
    }

    let ocr: InvoiceOcrResult | null = null;
    const configuration = invoiceOcrConfiguration();
    if ((type === "Invoice" || type === "Receipt") && configuration.configured) {
      ocr = await processInvoiceDocument({
        bytes: await file.arrayBuffer(),
        mimeType: file.type || "image/jpeg",
        displayName: file.name,
        documentType: type,
      });
    }

    const manualVendor = clean(form.get("vendor"), 180);
    const manualReference = clean(form.get("reference"), 100);
    const vendor = manualVendor || confidentValue(ocr?.fields.vendor, "");
    const reference = manualReference || confidentValue(ocr?.fields.invoiceNumber, "");
    const requestedDate = validDate(form.get("documentDate"));
    const ocrDate = confidentValue(ocr?.fields.invoiceDate, "");
    const documentDate = requestedDate || ocrDate || new Date().toISOString().slice(0, 10);
    const title = titleFor({
      type,
      manualTitle: clean(form.get("title"), 180),
      vendor,
      reference,
    }).slice(0, 180);
    const generatedFileName = fileNameFor({ business, type, documentDate, vendor, reference, title });
    const notes = [
      clean(form.get("notes"), 1_000),
      `Scanned as ${type} by ${access.actor}.`,
      "Image converted to black and white in the Corner Ops mobile scanner.",
      ...ocrNotes(ocr),
      !configuration.configured && (type === "Invoice" || type === "Receipt")
        ? `OCR was skipped because configuration is missing: ${configuration.missing.join(", ")}.`
        : "",
    ].filter(Boolean).join(" ").slice(0, 2_000);

    const status: DocumentStatus = access.mode === "owner" && ocr && ocr.overallConfidence < OCR_AUTO_ACCEPT_CONFIDENCE
      ? "Needs Review"
      : access.status;
    const pathname = `${business === "Corner Deli" ? "corner-deli" : "tiki"}/scanned-documents/${Date.now()}-${generatedFileName}`;
    const blob = await put(pathname, file, {
      access: "private",
      addRandomSuffix: true,
      contentType: "image/jpeg",
    });
    uploadedUrl = blob.url;

    const document = await insertDocument({
      id: crypto.randomUUID(),
      business,
      title,
      category: categoryFor(type),
      documentDate,
      status,
      notes,
      fileName: generatedFileName,
      contentType: "image/jpeg",
      sizeBytes: file.size,
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      createdBy: access.actor,
    });

    await recordAuditEvent({
      business,
      documentId: document.id,
      action: "uploaded",
      actor: access.actor,
      details: {
        title: document.title,
        fileName: document.fileName,
        source: "mobile-scanner",
        documentType: type,
        accessMode: access.mode,
        ocrProvider: ocr?.provider || null,
      },
    });

    return Response.json({
      document,
      accessMode: access.mode,
      documentType: type,
      ocr: ocr ? {
        provider: ocr.provider,
        confidence: ocr.overallConfidence,
        vendor: ocr.fields.vendor.value,
        reference: ocr.fields.invoiceNumber.value,
        total: ocr.fields.totalAmount.value,
        warnings: ocr.warnings,
      } : null,
    }, { status: 201 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
