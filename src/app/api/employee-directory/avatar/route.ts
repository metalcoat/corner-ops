import { get } from "@/lib/storage";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { ownerEmployeeProfilePhoto } from "@/lib/employee-profile";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.read");
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const employeeId = url.searchParams.get("id") || "";
    if (!employeeId) return Response.json({ error: "Employee ID is required." }, { status: 400 });
    const photo = await ownerEmployeeProfilePhoto(business, employeeId);
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
