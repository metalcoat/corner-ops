import { NextResponse } from "next/server";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { getCornerDeliHandbook, listHandbookEmployeeStatus } from "@/lib/employee-handbook";
import { sendStaffNotification } from "@/lib/staff-notifications";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    requirePermission(session, "workforce.read");
    if (!canAccessBusiness(session, "Corner Deli")) return NextResponse.json({ error: "Corner Deli access denied." }, { status: 403 });
    const [handbook, employees] = await Promise.all([
      Promise.resolve(getCornerDeliHandbook()),
      listHandbookEmployeeStatus("Corner Deli"),
    ]);
    return NextResponse.json({ business: "Corner Deli", handbook, employees });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Handbook status could not be loaded." }, { status: 400 });
  }
}

/**
 * Owner: send the current handbook to every active employee who hasn't signed this version (app message,
 * notification, email, and a text where they agreed to texts). Refused while the handbook is a draft.
 */
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    requirePermission(session, "workforce.write");
    if (!canAccessBusiness(session, "Corner Deli")) return NextResponse.json({ error: "Corner Deli access denied." }, { status: 403 });
    const body = await request.json().catch(() => ({})) as { action?: string };
    if (body.action !== "send-unsigned") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const handbook = getCornerDeliHandbook();
    if (/draft/i.test(handbook.version)) return NextResponse.json({ error: "The handbook is still marked draft. Finish the wording first, then send it." }, { status: 409 });
    const unsigned = (await listHandbookEmployeeStatus("Corner Deli")).filter((employee) => employee.active && !employee.acknowledged);
    let sent = 0;
    for (const employee of unsigned) {
      await sendStaffNotification({
        business: "Corner Deli",
        recipientEmployeeId: employee.employeeId,
        actor: session.displayName,
        sendSms: true,
        body: `We've updated the Corner Deli employee handbook (effective ${handbook.effectiveDate}). Please read it and sign at the bottom: open the Corner Deli app → Handbook.`,
      });
      sent += 1;
    }
    return NextResponse.json({ sent, alreadySigned: (await listHandbookEmployeeStatus("Corner Deli")).filter((employee) => employee.active && employee.acknowledged).length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Handbook could not be sent." }, { status: 400 });
  }
}
