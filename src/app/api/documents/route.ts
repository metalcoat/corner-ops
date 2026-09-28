import { del, put } from "@/lib/storage";
import { recordAuditEvent } from "@/lib/audit";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import { insertDocument, listDocuments } from "@/lib/documents";
import { apiError, unauthorized } from "@/lib/http";
import { documentStatuses, type Business, type DocumentStatus } from "@/lib/types";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const allowedExtensions = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "csv", "txt", "doc", "docx", "xls", "xlsx",
]);

function cleanText(value: FormDataEntryValue | null, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

function extension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const business = new URL(request.url).searchParams.get("business") || "";
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Unknown or inaccessible business." }, { status: 403 });
    }

    assertConfigured("DATABASE_URL");
    return Response.json({ documents: await listDocuments(business) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl: string | null = null;
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    assertConfigured("DATABASE_URL", "BLOB_READ_WRITE_TOKEN");

    const form = await request.formData();
    const businessValue = cleanText(form.get("business"), 40);
    if (!canAccessBusiness(session, businessValue)) {
      return Response.json({ error: "Unknown or inaccessible business." }, { status: 403 });
    }
    const business = businessValue as Business;

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "Choose a file to upload." }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: "Files are limited to 20 MB." }, { status: 413 });
    }
    if (!allowedExtensions.has(extension(file.name))) {
      return Response.json({ error: "That file type is not allowed." }, { status: 415 });
    }

    const title = cleanText(form.get("title"), 180) || file.name;
    const category = cleanText(form.get("category"), 80) || "General";
    const notes = cleanText(form.get("notes"), 2000);
    const dateValue = cleanText(form.get("documentDate"), 10);
    const documentDate = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? dateValue : new Date().toISOString().slice(0, 10);
    const statusValue = cleanText(form.get("status"), 30);
    const status: DocumentStatus = documentStatuses.includes(statusValue as DocumentStatus)
      ? (statusValue as DocumentStatus)
      : "Active";

    const pathname = `${business === "Corner Deli" ? "corner-deli" : "tiki"}/${Date.now()}-${safeFileName(file.name)}`;
    const blob = await put(pathname, file, { access: "private", addRandomSuffix: true });
    uploadedUrl = blob.url;

    const document = await insertDocument({
      id: crypto.randomUUID(),
      business,
      title,
      category,
      documentDate,
      status,
      notes,
      fileName: file.name.slice(0, 255),
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      createdBy: session.email,
    });

    await recordAuditEvent({
      business,
      documentId: document.id,
      action: "uploaded",
      actor: session.email,
      details: { title: document.title, fileName: document.fileName },
    });

    return Response.json({ document }, { status: 201 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
