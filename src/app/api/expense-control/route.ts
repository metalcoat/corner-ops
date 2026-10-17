import { del, put } from "@/lib/storage";
import { canAccessBusiness, getSession } from "@/lib/auth";
import {
  expenseControlDashboard,
  ingestReceipt,
  refreshCreditCardPaymentMatches,
  refreshReceiptMatches,
  reviewCreditCardPaymentMatch,
  reviewReceiptMatch,
  syncReceiptDriveFolder,
  validateReceiptFile,
} from "@/lib/expense-control";
import { apiError, unauthorized } from "@/lib/http";
import { syncAllBankConnections } from "@/lib/integrations";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "receipt";
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = businessFrom(new URL(request.url).searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    return Response.json(await expenseControlDashboard(business));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl = "";
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "Choose a receipt image or PDF." }, { status: 400 });
      }
      validateReceiptFile({ size: file.size, mimeType: file.type, fileName: file.name });
      const bytes = await file.arrayBuffer();
      const pathname = `receipts/${business === "Corner Deli" ? "corner-deli" : "tiki"}/${Date.now()}-${safeFileName(file.name)}`;
      const blob = await put(pathname, bytes, {
        access: "private",
        addRandomSuffix: true,
        contentType: file.type,
      });
      uploadedUrl = blob.url;
      const result = await ingestReceipt({
        business,
        source: "Upload",
        sourceKey: `upload:${blob.pathname}`,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        storageUrl: blob.url,
        storagePathname: blob.pathname,
        bytes,
        actor: session.email,
      });
      return Response.json(result, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }
    const action = String(body.action || "");

    if (action === "refresh") {
      const bankSync = body.syncBanks === false ? null : await syncAllBankConnections();
      return Response.json({
        bankSync,
        cardPayments: await refreshCreditCardPaymentMatches(business),
        receipts: await refreshReceiptMatches(business),
      });
    }
    if (action === "drive-sync") {
      return Response.json(await syncReceiptDriveFolder(business));
    }
    if (action === "transfer-review") {
      return Response.json(await reviewCreditCardPaymentMatch({
        id: String(body.id || ""),
        business,
        accept: body.accept === true,
        actor: session.email,
      }));
    }
    if (action === "receipt-review") {
      return Response.json(await reviewReceiptMatch({
        id: String(body.id || ""),
        business,
        accept: body.accept === true,
        actor: session.email,
      }));
    }
    return Response.json({ error: "Unknown cards and receipts action." }, { status: 400 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
