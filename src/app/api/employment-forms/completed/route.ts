import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { getEmploymentForm } from "@/lib/employment-forms";
import { EMPLOYMENT_FORM_SENSITIVE_PERMISSION } from "@/lib/employment-form-display";
import { apiError, AuthenticationError, PermissionError, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

// POST is intentional: opening a sensitive record requires an explicit user action,
// not link prefetching. Ordinary form lists/reviews remain redacted.
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) throw new AuthenticationError();
    requirePermission(session, EMPLOYMENT_FORM_SENSITIVE_PERMISSION);
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new PermissionError();
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
      throw new ValidationError("Send a JSON form-view request.");
    }
    const body = await request.json() as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Choose an employment form.");
    const business = body.business;
    if (business !== "Corner Deli" && business !== "Tiki") throw new ValidationError("Choose Corner Deli or Tiki.");
    if (!canAccessBusiness(session, business)) throw new PermissionError("Business access denied.");
    if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id)) {
      throw new ValidationError("Choose a valid employment form.");
    }

    // The database query is business-scoped before decryption.
    const form = await getEmploymentForm(body.id, { business });
    if (!form || form.business !== business) {
      return privateResponse(Response.json({ error: "Employment form was not found." }, { status: 404 }));
    }
    const submission = form.payload.employeeSubmission;
    if (!form.employeeSignedAt || form.status === "Assigned" || !submission || typeof submission !== "object" || !Object.keys(submission).length) {
      return privateResponse(Response.json({ error: "The employee has not submitted a signed form yet." }, { status: 409 }));
    }

    // Fail closed when the access audit cannot be written. Never log the payload,
    // SSN, tax answers, or identity-document numbers in either success or failure.
    await recordAuditEvent({
      business, actor: session.email, entityType: "employment-form", entityId: form.id,
      action: "Viewed completed employment form for payroll",
      details: { formType: form.formType, purpose: "Payroll entry", sensitiveAccess: true },
    });
    return privateResponse(Response.json({ form, sensitive: true }));
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof PermissionError || error instanceof ValidationError) {
      return privateResponse(apiError(error));
    }
    if (error instanceof SyntaxError) {
      return privateResponse(Response.json({ error: "The form-view request was invalid." }, { status: 400 }));
    }
    console.error("[employment-forms] completed form access failed; sensitive details omitted");
    return privateResponse(Response.json({ error: "The completed form could not be opened securely. Try again." }, { status: 500 }));
  }
}
