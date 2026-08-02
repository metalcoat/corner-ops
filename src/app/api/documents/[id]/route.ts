import { del } from "@vercel/blob";
import { recordAuditEvent } from "@/lib/audit";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import { findDocument, removeDocument, updateDocument } from "@/lib/documents";
import { apiError, unauthorized } from "@/lib/http";
import { documentStatuses, type DocumentStatus } from "@/lib/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    assertConfigured("DATABASE_URL");

    const { id } = await context.params;
    const current = await findDocument(id);
    if (!current) return Response.json({ error: "Document not found." }, { status: 404 });
    if (!canAccessBusiness(session, current.business)) {
      return Response.json({ error: "Document access denied." }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const title = text(body.title, 180);
    const category = text(body.category, 80) || "General";
    const notes = text(body.notes, 2000);
    const dateValue = text(body.documentDate, 10);
    const statusValue = text(body.status, 30);
    if (!title) return Response.json({ error: "Title is required." }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return Response.json({ error: "A valid document date is required." }, { status: 400 });
    }
    const status: DocumentStatus = documentStatuses.includes(statusValue as DocumentStatus)
      ? statusValue as DocumentStatus
      : current.status;

    const document = await updateDocument(id, { title, category, notes, documentDate: dateValue, status });
    if (!document) return Response.json({ error: "Document not found." }, { status: 404 });

    const action = current.status !== status
      ? status === "Archived" ? "archived" : current.status === "Archived" ? "restored" : "updated"
      : "updated";
    await recordAuditEvent({
      business: current.business,
      documentId: id,
      action,
      actor: session.email,
      details: { title, previousStatus: current.status, status },
    });

    return Response.json({ document });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    assertConfigured("DATABASE_URL", "BLOB_READ_WRITE_TOKEN");

    const { id } = await context.params;
    const document = await findDocument(id);
    if (!document) return Response.json({ error: "Document not found." }, { status: 404 });
    if (!canAccessBusiness(session, document.business)) {
      return Response.json({ error: "Document access denied." }, { status: 403 });
    }
    if (document.status !== "Archived") {
      return Response.json({ error: "Archive the document before permanently deleting it." }, { status: 409 });
    }

    await del(document.blobUrl);
    await removeDocument(id);
    await recordAuditEvent({
      business: document.business,
      documentId: id,
      action: "deleted",
      actor: session.email,
      details: { title: document.title, fileName: document.fileName },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
