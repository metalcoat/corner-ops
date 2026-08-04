import { NextRequest, NextResponse } from "next/server";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import {
  assignOnboardingPacket,
  assignRateChange,
  completeEmployerI9,
  getEmploymentForm,
  getEmploymentFormProfile,
  listEmploymentEmployees,
  listEmploymentForms,
  saveEmploymentFormProfile,
  type EmploymentFormProfile,
} from "@/lib/employment-forms";
import type { Business } from "@/lib/types";

function businessValue(value: unknown): Business {
  if (value !== "Corner Deli" && value !== "Tiki") throw new Error("Choose Corner Deli or Tiki.");
  return value;
}

function clientMetadata(request: NextRequest) {
  return {
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown",
    userAgent: request.headers.get("user-agent") || "unknown",
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    requirePermission(session, "workforce.read");
    const business = businessValue(request.nextUrl.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) return NextResponse.json({ error: "Business access denied." }, { status: 403 });
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      const form = await getEmploymentForm(id);
      if (!form || form.business !== business) return NextResponse.json({ error: "Employment form was not found." }, { status: 404 });
      return NextResponse.json({ form });
    }
    const [forms, employees, profile] = await Promise.all([
      listEmploymentForms(business),
      listEmploymentEmployees(business),
      getEmploymentFormProfile(business),
    ]);
    return NextResponse.json({ business, forms, employees, profile });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employment forms could not be loaded." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    requirePermission(session, "workforce.write");
    const body = await request.json() as Record<string, unknown>;
    const business = businessValue(body.business);
    if (!canAccessBusiness(session, business)) return NextResponse.json({ error: "Business access denied." }, { status: 403 });
    const action = String(body.action || "");

    if (action === "save-profile") {
      const profile: EmploymentFormProfile = {
        legalName: String(body.legalName || "").trim(),
        dba: String(body.dba || business).trim(),
        ein: String(body.ein || "").trim(),
        address: String(body.address || "").trim(),
        phone: String(body.phone || "").trim(),
        payFrequency: String(body.payFrequency || "Weekly").trim(),
        payday: String(body.payday || "").trim(),
        dependentHealthAvailable: Boolean(body.dependentHealthAvailable),
        dependentHealthEligibility: String(body.dependentHealthEligibility || "").trim(),
      };
      if (!profile.legalName || !profile.ein || !profile.address || !profile.phone || !profile.payday) {
        throw new Error("Legal name, EIN, address, phone, and regular payday are required.");
      }
      return NextResponse.json({ profile: await saveEmploymentFormProfile(business, profile, session.email) });
    }

    if (action === "assign-packet") {
      const forms = await assignOnboardingPacket({
        business,
        employeeId: String(body.employeeId || ""),
        hireDate: String(body.hireDate || ""),
        actor: session.email,
        employerSignature: String(body.employerSignature || ""),
      });
      return NextResponse.json({ forms }, { status: 201 });
    }

    if (action === "rate-change") {
      const form = await assignRateChange({
        business,
        employeeId: String(body.employeeId || ""),
        effectiveDate: String(body.effectiveDate || ""),
        hourlyRate: Number(body.hourlyRate),
        tippedRate: Number(body.tippedRate || 0),
        actor: session.email,
        employerSignature: String(body.employerSignature || ""),
      });
      return NextResponse.json({ form }, { status: 201 });
    }

    if (action === "complete-i9") {
      const metadata = clientMetadata(request);
      const form = await completeEmployerI9({
        id: String(body.id || ""),
        business,
        actor: session.email,
        signatureName: String(body.signatureName || ""),
        payload: typeof body.payload === "object" && body.payload ? body.payload as Record<string, unknown> : {},
        ...metadata,
      });
      return NextResponse.json({ form });
    }

    throw new Error("Unknown employment forms action.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employment form update failed." }, { status: 400 });
  }
}
