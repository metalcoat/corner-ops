import { get } from "@vercel/blob";
import { getEmployeeSession } from "@/lib/employee-auth";
import { employeeMessageAttachment } from "@/lib/message-attachments";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!id) return Response.json({ error: "Message ID is required." }, { status: 400 });
    const attachment = await employeeMessageAttachment(session, id);
    if (!attachment) return new Response("Photo not found.", { status: 404 });

    const result = await get(attachment.pathname, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") || undefined,
    });
    if (!result) return new Response("Photo not found.", { status: 404 });
    if (result.statusCode === 304) {
      return new Response(null, {
        status: 304,
        headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" },
      });
    }
    if (result.statusCode !== 200 || !result.stream) return new Response("Photo not found.", { status: 404 });
    return new Response(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType || attachment.contentType,
        "Content-Disposition": `inline; filename="${attachment.fileName.replaceAll('"', '')}"`,
        "Content-Length": String(result.blob.size || attachment.size),
        "X-Content-Type-Options": "nosniff",
        ETag: result.blob.etag,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
