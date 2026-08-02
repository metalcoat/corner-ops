import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  approveBankTransaction,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  importBankFile,
  integrationDashboard,
  syncBankConnection,
  syncSquareConnection,
} from "@/lib/integrations";
import { runScheduledOperations } from "@/lib/scheduler";
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
    const value = new URL(request.url).searchParams.get("business");
    const business = value ? businessFrom(value) : undefined;
    if (business && !canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json(await integrationDashboard(business));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      if (String(form.get("action") || "") !== "bank-file-import") {
        return Response.json({ error: "Unknown integration upload." }, { status: 400 });
      }
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return Response.json({ error: "Choose a bank CSV or Excel file." }, { status: 400 });
      }
      if (file.size > 25 * 1024 * 1024) {
        return Response.json({ error: "Bank import files are limited to 25 MB." }, { status: 413 });
      }
      if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
        return Response.json({ error: "Bank imports must be CSV or Excel files." }, { status: 415 });
      }
      const result = await importBankFile({
        business,
        institutionName: String(form.get("institutionName") || "Bank CSV"),
        fileName: file.name,
        bytes: await file.arrayBuffer(),
        actor: session.email,
      });
      return Response.json(result, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "plaid-link-token") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const origin = new URL(request.url).origin;
      return Response.json(await createPlaidLinkToken({ business, origin }));
    }

    if (action === "plaid-exchange") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      return Response.json(await exchangePlaidPublicToken({
        business,
        publicToken: String(body.publicToken || ""),
        institutionName: body.institutionName ? String(body.institutionName) : undefined,
      }), { status: 201 });
    }

    if (action === "bank-sync") {
      return Response.json(await syncBankConnection(String(body.connectionId || "")));
    }

    if (action === "square-sync") {
      return Response.json(await syncSquareConnection(body.connectionId ? String(body.connectionId) : undefined));
    }

    if (action === "transaction-approve") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      return Response.json(await approveBankTransaction({
        id: String(body.id || ""),
        business,
        category: String(body.category || ""),
        accountCode: String(body.accountCode || ""),
        actor: session.email,
        teach: body.teach !== false,
      }));
    }

    if (action === "scheduler-run") {
      return Response.json(await runScheduledOperations({ force: true, source: session.email }));
    }

    return Response.json({ error: "Unknown integration action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
