import { get } from "@vercel/blob";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import { findDocument } from "@/lib/documents";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    assertConfigured("DATABASE_URL", "BLOB_READ_WRITE_TOKEN");

    const { id } = await context.params;
    const document = await findDocument(id);
    if (!document) return new Response("Not found", { status: 404 });
    if (!canAccessBusiness(session, document.business)) return new Response("Forbidden", { status: 403 });

    const result = await get(document.blobUrl, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    });
    if (!result) return new Response("Not found", { status: 404 });

    if (result.statusCode === 304) {
      return new Response(null, {
        status: 304,
        headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" },
      });
    }

    return new Response(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType || document.contentType,
        "Content-Disposition": contentDisposition(document.fileName),
        "X-Content-Type-Options": "nosniff",
        ETag: result.blob.etag,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
