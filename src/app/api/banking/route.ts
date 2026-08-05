import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { applyBankCodingSuggestions, bankCodingIntelligence } from "@/lib/bank-coding-intelligence";
import { bankFinancialInsights } from "@/lib/bank-financial-insights";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.read");
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const [coding, financial] = await Promise.all([
      bankCodingIntelligence(business),
      bankFinancialInsights({
        business,
        start: url.searchParams.get("start") || undefined,
        end: url.searchParams.get("end") || undefined,
        interval: url.searchParams.get("interval") || undefined,
      }),
    ]);
    return Response.json({ ...coding, financial });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.write");
    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    if (String(body.action || "") !== "apply-suggestions") {
      return Response.json({ error: "Unknown banking action." }, { status: 400 });
    }
    return Response.json(await applyBankCodingSuggestions({
      business,
      minimumConfidence: Number(body.minimumConfidence || 0.9),
      transactionIds: Array.isArray(body.transactionIds) ? body.transactionIds.map(String) : [],
      actor: session.email,
    }));
  } catch (error) {
    return apiError(error);
  }
}
