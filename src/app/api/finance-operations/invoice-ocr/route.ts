import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { invoiceOcrConfiguration, processInvoiceDocument } from "@/lib/invoice-ocr";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILE_SIZE = 25 * 1024 * 1024;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function mimeTypeFor(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.read");
    return Response.json(invoiceOcrConfiguration());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.write");

    const form = await request.formData();
    const business = businessFrom(form.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      return Response.json({ error: "Choose a PDF or invoice image." }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: "Invoice OCR files are limited to 25 MB." }, { status: 413 });
    }
    if (!/\.(pdf|jpg|jpeg|png|webp)$/i.test(file.name)) {
      return Response.json({ error: "Invoice OCR accepts PDF, JPG, PNG, or WebP files." }, { status: 415 });
    }

    const configuration = invoiceOcrConfiguration();
    if (!configuration.configured) {
      return Response.json({
        error: `Invoice OCR is not configured. Missing: ${configuration.missing.join(", ")}.`,
        configuration,
      }, { status: 503 });
    }

    const result = await processInvoiceDocument({
      bytes: await file.arrayBuffer(),
      mimeType: mimeTypeFor(file),
      displayName: file.name,
    });
    return Response.json({ business, fileName: file.name, ...result });
  } catch (error) {
    return apiError(error);
  }
}
