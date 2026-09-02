import { NextResponse } from "next/server";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { getCornerDeliHandbook, listHandbookEmployeeStatus } from "@/lib/employee-handbook";

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
