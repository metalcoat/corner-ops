import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { canViewCompletedEmploymentForms } from "@/lib/employment-form-display";
import { apiError, unauthorized } from "@/lib/http";
import { listI9Documents, readI9Document } from "@/lib/i9-documents";
import { recordAuditEvent } from "@/lib/audit";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

/** I-9 document copies for the employer's Section 2 review. Same access as viewing completed forms. */
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.read");
    if (!canViewCompletedEmploymentForms(session.permissions)) return Response.json({ error: "Viewing I-9 documents needs the sensitive employment forms permission." }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const business = params.get("business") === "Tiki" ? "Tiki" : "Corner Deli" as Business;
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const id = params.get("id");
    if (id) {
      const file = await readI9Document({ business, documentId: id });
      await recordAuditEvent({ business, action: "i9-document-viewed", actor: session.email, entityType: "employment_form_document", entityId: id });
      return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.contentType, "Cache-Control": "private, no-store", "Content-Disposition": "inline" } });
    }
    return Response.json(await listI9Documents(business, String(params.get("formId") || "")));
  } catch (error) {
    return apiError(error);
  }
}
