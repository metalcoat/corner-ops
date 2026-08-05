import { NextRequest, NextResponse } from "next/server";
import { getEmployeeSession } from "@/lib/employee-auth";
import { latestDirectDepositAssignmentWasRescinded } from "@/lib/direct-deposit-admin";
import {
  ensureEmployeeDirectDepositElection,
  getDirectDepositElection,
  listDirectDepositElections,
  submitDirectDepositElection,
} from "@/lib/direct-deposit";

function metadata(request: NextRequest) {
  return {
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown",
    userAgent: request.headers.get("user-agent") || "unknown",
  };
}

function digits(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

function validRoutingNumber(value: unknown): boolean {
  const routing = digits(value);
  if (routing.length !== 9) return false;
  const number = routing.split("").map(Number);
  const checksum = 3 * (number[0] + number[3] + number[6])
    + 7 * (number[1] + number[4] + number[7])
    + number[2] + number[5] + number[8];
  return checksum % 10 === 0;
}

function validate(payload: Record<string, unknown>) {
  const choice = String(payload.paymentChoice || "");
  if (choice !== "direct-deposit" && choice !== "paper-check") throw new Error("Choose direct deposit or paper check.");
  if (payload.attest !== true) throw new Error("Confirm the payment-method election before signing.");
  if (choice === "paper-check") return;

  const required = ["accountHolderName", "financialInstitution", "routingNumber", "accountNumber", "accountType", "depositAllocation"];
  if (required.some((name) => !String(payload[name] || "").trim())) throw new Error("Complete all bank fields before authorizing direct deposit.");
  if (payload.directDepositConsent !== true) throw new Error("Confirm voluntary direct-deposit authorization.");
  if (!validRoutingNumber(payload.routingNumber)) throw new Error("Enter a valid nine-digit routing number.");
  const account = digits(payload.accountNumber);
  if (account.length < 4 || account.length > 17) throw new Error("Enter a valid account number.");
  if (payload.accountType !== "checking" && payload.accountType !== "savings") throw new Error("Choose checking or savings.");
  if (payload.depositAllocation !== "entire-net-pay") throw new Error("Choose how wages should be deposited.");
}

export async function GET(request: NextRequest) {
  try {
    const session = await getEmployeeSession();
    if (!session) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });

    const autoAssignmentSuppressed = await latestDirectDepositAssignmentWasRescinded({
      business: session.business,
      employeeId: session.employeeId,
    });
    if (!autoAssignmentSuppressed) {
      await ensureEmployeeDirectDepositElection({ business: session.business, employeeId: session.employeeId });
    }

    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      const election = await getDirectDepositElection(id);
      if (!election || election.employeeId !== session.employeeId || election.business !== session.business || election.status === "Superseded") {
        return NextResponse.json({ error: "Direct-deposit form was not found." }, { status: 404 });
      }
      return NextResponse.json({ election });
    }

    const elections = await listDirectDepositElections(session.business, session.employeeId);
    return NextResponse.json({
      employee: { id: session.employeeId, name: session.name, business: session.business, position: session.position },
      elections: elections.filter((election) => election.status !== "Superseded"),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Direct-deposit records could not be loaded." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getEmployeeSession();
    if (!session) return NextResponse.json({ error: "Employee sign-in required." }, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    const payload = typeof body.payload === "object" && body.payload ? body.payload as Record<string, unknown> : {};
    validate(payload);
    const election = await submitDirectDepositElection({
      id: String(body.id || ""),
      business: session.business,
      employeeId: session.employeeId,
      signatureName: String(body.signatureName || ""),
      payload,
      ...metadata(request),
    });
    return NextResponse.json({ election });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Direct-deposit election failed." }, { status: 400 });
  }
}
