import { NextRequest, NextResponse } from "next/server";
import { getEmployeeSession } from "@/lib/employee-auth";
import {
  acknowledgeEmployeeHandbook,
  getCornerDeliHandbook,
  getEmployeeHandbookAcknowledgment,
} from "@/lib/employee-handbook";

function clientMetadata(request: NextRequest) {
  return {
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown",
    userAgent: request.headers.get("user-agent") || "unknown",
  };
}

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
    if (session.business !== "Corner Deli") {
      return NextResponse.json({ error: "The Corner Deli handbook is not assigned to this employee." }, { status: 404 });
    }
    const [handbook, acknowledgment] = await Promise.all([
      Promise.resolve(getCornerDeliHandbook()),
      getEmployeeHandbookAcknowledgment(session.employeeId, session.business),
    ]);
    return NextResponse.json({
      employee: { id: session.employeeId, name: session.name, business: session.business, position: session.position },
      handbook,
      acknowledgment,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employee handbook could not be loaded." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getEmployeeSession();
    if (!session) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
    if (session.business !== "Corner Deli") throw new Error("The Corner Deli handbook is not assigned to this employee.");
    const body = await request.json() as Record<string, unknown>;
    if (body.attest !== true) throw new Error("Confirm that you reviewed the handbook before signing.");
    const acknowledgment = await acknowledgeEmployeeHandbook({
      employeeId: session.employeeId,
      employeeName: session.name,
      business: session.business,
      signatureName: String(body.signatureName || ""),
      ...clientMetadata(request),
    });
    return NextResponse.json({ acknowledgment });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Handbook acknowledgment failed." }, { status: 400 });
  }
}
