import { get } from "@vercel/blob";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { ensureFinanceOperationsSchema } from "@/lib/finance-operations-schema";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, context: Context) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.read");
    await ensureFinanceOperationsSchema();
    const { id } = await context.params;
    const rows = await getSql()`
      SELECT id, business, file_name, content_type, blob_url
      FROM vendor_bills WHERE id = ${id} LIMIT 1
    ` as unknown as Array<{
      id: string;
      business: Business;
      file_name: string;
      content_type: string;
      blob_url: string;
    }>;
    const bill = rows[0];
    if (!bill || !bill.blob_url) return new Response("Not found", { status: 404 });
    if (!canAccessBusiness(session, bill.business)) return new Response("Forbidden", { status: 403 });
    const result = await get(bill.blob_url, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") || undefined,
    });
    if (!result) return new Response("Not found", { status: 404 });
    if (result.statusCode === 304) {
      return new Response(null, { status: 304, headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" } });
    }
    return new Response(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType || bill.content_type || "application/octet-stream",
        "Content-Disposition": contentDisposition(bill.file_name || "vendor-bill"),
        "X-Content-Type-Options": "nosniff",
        ETag: result.blob.etag,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
