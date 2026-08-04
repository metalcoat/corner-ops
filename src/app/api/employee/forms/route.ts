import { NextRequest, NextResponse } from "next/server";
import { getEmployeeSession } from "@/lib/employee-auth";
import {
  getEmploymentForm,
  listEmploymentForms,
  submitEmployeeEmploymentForm,
  type EmploymentFormType,
} from "@/lib/employment-forms";

function clientMetadata(request: NextRequest) {
  return {
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown",
    userAgent: request.headers.get("user-agent") || "unknown",
  };
}

function digits(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

function required(payload: Record<string, unknown>, names: string[]): void {
  const missing = names.filter((name) => !String(payload[name] || "").trim());
  if (missing.length) throw new Error("Complete all required fields before signing.");
}

function validateSubmission(type: EmploymentFormType, payload: Record<string, unknown>): void {
  if (payload.attest !== true) throw new Error("Confirm the certification before signing.");
  if (type === "W4") {
    required(payload, ["firstName", "lastName", "address", "city", "state", "zip", "ssn", "filingStatus"]);
    if (digits(payload.ssn).length !== 9) throw new Error("Enter a valid nine-digit Social Security number.");
  } else if (type === "IT2104") {
    required(payload, ["address", "city", "state", "zip", "ssn", "nysAllowances"]);
    if (digits(payload.ssn).length !== 9) throw new Error("Enter a valid nine-digit Social Security number.");
  } else if (type === "I9") {
    required(payload, ["lastName", "firstName", "address", "city", "state", "zip", "dateOfBirth", "citizenshipStatus"]);
    if (payload.ssn && digits(payload.ssn).length !== 9) throw new Error("The Social Security number must contain nine digits.");
    if (payload.preparerTranslator === "used") {
      throw new Error("A preparer or translator requires Form I-9 Supplement A. Complete that supplement with management before signing electronically.");
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getEmployeeSession();
    if (!session) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      const form = await getEmploymentForm(id);
      if (!form || form.employeeId !== session.employeeId || form.business !== session.business) {
        return NextResponse.json({ error: "Employment form was not found." }, { status: 404 });
      }
      if (form.status !== "Assigned") return NextResponse.json({ form: { ...form, payload: undefined } });
      return NextResponse.json({ form });
    }
    return NextResponse.json({
      employee: { id: session.employeeId, name: session.name, business: session.business, position: session.position },
      forms: await listEmploymentForms(session.business, session.employeeId),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employment forms could not be loaded." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getEmployeeSession();
    if (!session) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    const id = String(body.id || "");
    const form = await getEmploymentForm(id);
    if (!form || form.employeeId !== session.employeeId || form.business !== session.business) throw new Error("Employment form was not found.");
    const payload = typeof body.payload === "object" && body.payload ? body.payload as Record<string, unknown> : {};
    validateSubmission(form.formType, payload);
    const updated = await submitEmployeeEmploymentForm({
      id,
      employeeId: session.employeeId,
      business: session.business,
      signatureName: String(body.signatureName || ""),
      payload,
      ...clientMetadata(request),
    });
    return NextResponse.json({ form: updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employment form submission failed." }, { status: 400 });
  }
}
