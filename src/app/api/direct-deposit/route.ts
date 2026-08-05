import { NextRequest, NextResponse } from "next/server";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import {
  getDirectDepositAudit,
  listDirectDepositAudit,
  rescindDirectDepositElection,
  type DirectDepositAudit,
} from "@/lib/direct-deposit-admin";
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

function withAudit<T extends { id: string; status: string }>(item: T, audit: DirectDepositAudit | null) {
  return {
    ...item,
    status: audit?.rescindedAt ? "Rescinded" : item.status,
    assignedBy: audit?.assignedBy || "Unknown",
    rescindedBy: audit?.rescindedBy || null,
    rescindedAt: audit?.rescindedAt || null,
    rescindReason: audit?.rescindReason || "",
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
      const [election, audit] = await Promise.all([
        getDirectDepositElection(id),
        getDirectDepositAudit(id),
      ]);
      if (!election || election.business !== business) return NextResponse.json({ error: "Direct-deposit record was not found." }, { status: 404 });
      return NextResponse.json({ election: withAudit(election, audit) });
    }
    const [employees, elections, audits] = await Promise.all([
      listDirectDepositEmployees(business),
      listDirectDepositElections(business),
      listDirectDepositAudit(business),
    ]);
    const auditById = new Map(audits.map((item) => [item.id, item]));
    return NextResponse.json({
      business,
      employees,
      elections: elections.map((item) => withAudit(item, auditById.get(item.id) || null)),
    });
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
    const actor = session.displayName || session.email;

    if (body.action === "assign") {
      const election = await assignDirectDepositElection({
        business,
        employeeId: String(body.employeeId || ""),
        actor,
      });
      const audit = await getDirectDepositAudit(election.id);
      return NextResponse.json({ election: withAudit(election, audit) }, { status: 201 });
    }

    if (body.action === "rescind") {
      const audit = await rescindDirectDepositElection({
        id: String(body.id || ""),
        business,
        actor,
        reason: String(body.reason || "Assigned in error"),
      });
      return NextResponse.json({ rescinded: true, audit });
    }

    throw new Error("Unknown direct-deposit action.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Direct-deposit action could not be completed." }, { status: 400 });
  }
}
