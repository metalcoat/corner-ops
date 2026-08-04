import { NextRequest, NextResponse } from "next/server";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import {
  assignDirectDepositElection,
  getDirectDepositElection,
  listDirectDepositElections,
  listDirectDepositEmployees,
} from "@/lib/direct-deposit";
import type { Business } from "@/lib/types";

function businessValue(value: unknown): Business {
  if (value !== "Corner Deli" && value !== "Tiki") throw new Error("Choose Corner Deli or Tiki.");
  return value;
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
      const election = await getDirectDepositElection(id);
      if (!election || election.business !== business) return NextResponse.json({ error: "Direct-deposit record was not found." }, { status: 404 });
      return NextResponse.json({ election });
    }
    const [employees, elections] = await Promise.all([
      listDirectDepositEmployees(business),
      listDirectDepositElections(business),
    ]);
    return NextResponse.json({ business, employees, elections });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Direct-deposit records could not be loaded." }, { status: 400 });
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
    if (body.action !== "assign") throw new Error("Unknown direct-deposit action.");
    const election = await assignDirectDepositElection({
      business,
      employeeId: String(body.employeeId || ""),
      actor: session.email,
    });
    return NextResponse.json({ election }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Direct-deposit form could not be assigned." }, { status: 400 });
  }
}
