import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  accountingControlDashboard,
  buildSquareDepositSuggestions,
  createOpeningBalance,
  importCodedHistory,
  postAllApprovedBankTransactions,
  postBankTransaction,
  postSquareDay,
  reopenBankReconciliation,
  saveBankReconciliation,
  saveTransactionSplits,
  setSquareDepositMatchStatus,
} from "@/lib/accounting-control";
import { squareOperationsDashboard, syncSquareOperations } from "@/lib/square-control";
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
    if (url.searchParams.get("area") === "square") {
      if (!canAccessBusiness(session, "Tiki")) return Response.json({ error: "Business access denied." }, { status: 403 });
      return Response.json(await squareOperationsDashboard());
    }
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await accountingControlDashboard(business));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.write");
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      if (String(form.get("action") || "") !== "historical-import") throw new Error("Unknown accounting upload.");
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
      const file = form.get("file");
      if (!(file instanceof File) || !file.size) throw new Error("Choose a coded bookkeeping workbook.");
      if (file.size > 30 * 1024 * 1024) return Response.json({ error: "Historical imports are limited to 30 MB." }, { status: 413 });
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return Response.json({ error: "Historical imports must be Excel or CSV files." }, { status: 415 });
      return Response.json(await importCodedHistory({
        business,
        institutionName: String(form.get("institutionName") || "Historical workbook"),
        fileName: file.name,
        bytes: await file.arrayBuffer(),
        postApproved: String(form.get("postApproved") || "") === "true",
        actor: session.email,
      }), { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "square-sync-full") {
      if (!canAccessBusiness(session, "Tiki")) return Response.json({ error: "Business access denied." }, { status: 403 });
      return Response.json(await syncSquareOperations());
    }
    if (action === "square-match-build") return Response.json(await buildSquareDepositSuggestions(session.email));
    if (action === "square-match-status") return Response.json(await setSquareDepositMatchStatus({
      id: String(body.id || ""), status: body.status === "Ignored" ? "Ignored" : "Matched", actor: session.email,
    }));
    if (action === "square-day-post") return Response.json(await postSquareDay({ businessDate: String(body.businessDate || ""), actor: session.email }));

    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    if (action === "transaction-split") return Response.json(await saveTransactionSplits({
      transactionId: String(body.transactionId || ""), business,
      lines: Array.isArray(body.lines) ? body.lines as Array<{ accountCode: string; amount: number; memo?: string }> : [], actor: session.email,
    }));
    if (action === "transaction-post") return Response.json(await postBankTransaction({ transactionId: String(body.transactionId || ""), business, actor: session.email }));
    if (action === "post-approved") return Response.json(await postAllApprovedBankTransactions({ business, actor: session.email }));
    if (action === "opening-balance") return Response.json(await createOpeningBalance({
      business, entryDate: String(body.entryDate || ""), description: String(body.description || "Opening balances"),
      reference: String(body.reference || ""), lines: Array.isArray(body.lines) ? body.lines as Array<{ accountCode: string; debit?: number; credit?: number }> : [],
      actor: session.email,
    }), { status: 201 });
    if (action === "reconciliation-save") return Response.json(await saveBankReconciliation({
      id: body.id ? String(body.id) : undefined, business, externalAccountId: String(body.externalAccountId || ""),
      statementStartDate: String(body.statementStartDate || ""), statementEndDate: String(body.statementEndDate || ""),
      beginningBalance: Number(body.beginningBalance || 0), endingBalance: Number(body.endingBalance || 0),
      transactionIds: Array.isArray(body.transactionIds) ? body.transactionIds.map(String) : [], notes: String(body.notes || ""),
      finalize: Boolean(body.finalize), actor: session.email,
    }));
    if (action === "reconciliation-reopen") return Response.json(await reopenBankReconciliation(String(body.id || ""), session.email));
    return Response.json({ error: "Unknown accounting action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
