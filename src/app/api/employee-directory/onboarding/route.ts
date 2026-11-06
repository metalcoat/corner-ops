import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { createOnboardingEmployee, issueOnboardingInvite, listOnboardingInProgress, onboardingStatus, sendNewHirePayNotice } from "@/lib/employee-onboarding";
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
    const params = new URL(request.url).searchParams;
    const business = businessFrom(params.get("business"));
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const employeeId = params.get("employeeId");
    if (employeeId) return Response.json(await onboardingStatus(business, employeeId));
    return Response.json({ inProgress: await listOnboardingInProgress(business) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "workforce.write");
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const action = String(body.action || "");
    if (action === "add") {
      return Response.json(await createOnboardingEmployee({
        business,
        name: String(body.name || ""),
        phone: String(body.phone || ""),
        smsConsent: body.smsConsent === true,
        position: body.position ? String(body.position) : undefined,
        hourlyRate: body.hourlyRate ? Number(body.hourlyRate) : undefined,
        tippedRate: body.tippedRate ? Number(body.tippedRate) : undefined,
        actor: session.email,
        actorName: session.displayName,
      }), { status: 201 });
    }
    if (action === "resend") {
      return Response.json(await issueOnboardingInvite({ business, employeeId: String(body.employeeId || ""), actor: session.email }));
    }
    if (action === "pay-notice") {
      return Response.json(await sendNewHirePayNotice({
        business,
        employeeId: String(body.employeeId || ""),
        hourlyRate: Number(body.hourlyRate || 0),
        tippedRate: Number(body.tippedRate || 0),
        actor: session.email,
        actorName: session.displayName,
      }), { status: 201 });
    }
    return Response.json({ error: "Unknown onboarding action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
