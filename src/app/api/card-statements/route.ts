import { del, put } from "@/lib/storage";
import { canAccessBusiness, getSession } from "@/lib/auth";
import {
  cardStatementDashboard,
  confirmCardStatementMatch,
  createCardStatement,
} from "@/lib/card-statements";
import { assertConfigured } from "@/lib/config";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILE_SIZE = 25 * 1024 * 1024;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function clean(value: FormDataEntryValue | null, max = 255): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "card-statement";
}

function numeric(value: FormDataEntryValue | null): number {
  const source = typeof value === "string" ? value : "";
  const parsed = Number(source.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = businessFrom(new URL(request.url).searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json(await cardStatementDashboard(business));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl: string | null = null;
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      assertConfigured("DATABASE_URL", "BLOB_READ_WRITE_TOKEN");
      const form = await request.formData();
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const file = form.get("file");
      if (!(file instanceof File) || !file.size) {
        return Response.json({ error: "Choose a PDF, CSV, or Excel card statement." }, { status: 400 });
      }
      if (file.size > MAX_FILE_SIZE) {
        return Response.json({ error: "Card statement files are limited to 25 MB." }, { status: 413 });
      }
      if (!/\.(pdf|csv|xlsx|xls)$/i.test(file.name)) {
        return Response.json({ error: "Card statements must be PDF, CSV, or Excel files." }, { status: 415 });
      }
      const statementEndDate = clean(form.get("statementEndDate"), 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(statementEndDate)) {
        return Response.json({ error: "Choose the statement ending date." }, { status: 400 });
      }
      const pathname = `${business === "Corner Deli" ? "corner-deli" : "tiki"}/card-statements/${Date.now()}-${safeFileName(file.name)}`;
      const blob = await put(pathname, file, { access: "private", addRandomSuffix: true });
      uploadedUrl = blob.url;
      const result = await createCardStatement({
        business,
        issuer: clean(form.get("issuer"), 160),
        accountName: clean(form.get("accountName"), 160),
        lastFour: clean(form.get("lastFour"), 4).replace(/\D/g, ""),
        statementEndDate,
        statementBalance: numeric(form.get("statementBalance")),
        paymentAmount: numeric(form.get("paymentAmount")),
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        blobUrl: blob.url,
        blobPathname: blob.pathname,
        bytes: await file.arrayBuffer(),
        createdBy: session.email,
      });
      return Response.json(result, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    if (String(body.action || "") !== "confirm-match") {
      return Response.json({ error: "Unknown card statement action." }, { status: 400 });
    }
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json(await confirmCardStatementMatch({
      business,
      statementId: String(body.statementId || ""),
      bankTransactionId: String(body.bankTransactionId || ""),
    }));
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
