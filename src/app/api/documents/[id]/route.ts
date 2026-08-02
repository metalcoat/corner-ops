import { del } from "@vercel/blob";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import { findDocument, removeDocument } from "@/lib/documents";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

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

    await del(document.blobUrl);
    await removeDocument(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
