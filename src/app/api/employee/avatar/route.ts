import { get } from "@vercel/blob";
import { getEmployeeSession } from "@/lib/employee-auth";
import { employeeVisibleProfilePhoto } from "@/lib/employee-profile";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!id) return Response.json({ error: "Employee ID is required." }, { status: 400 });
    const photo = await employeeVisibleProfilePhoto(session, id);
    if (!photo) return new Response("Employee photo not found.", { status: 404 });

    const result = await get(photo.pathname, {
      access: "private",
      ifNoneMatch: request.headers.get("if-none-match") || undefined,
    });
    if (!result) return new Response("Employee photo not found.", { status: 404 });
    if (result.statusCode === 304) {
      return new Response(null, { status: 304, headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" } });
    }
    if (result.statusCode !== 200 || !result.stream) return new Response("Employee photo not found.", { status: 404 });
    return new Response(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType || photo.contentType,
        "Content-Disposition": `inline; filename="${photo.fileName.replaceAll('"', '')}"`,
        "Content-Length": String(result.blob.size || photo.size),
        "X-Content-Type-Options": "nosniff",
        ETag: result.blob.etag,
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
