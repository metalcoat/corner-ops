import { del, put } from "@vercel/blob";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { assertConfigured } from "@/lib/config";
import {
  addRecipeComponent,
  adjustInventoryQuantity,
  createForecastEvent,
  createInventoryItem,
  createRecipe,
  createVendorBill,
  deleteForecastEvent,
  recordInventoryPurchase,
  removeRecipeComponent,
  updateVendorBillStatus,
  type BillLineInput,
} from "@/lib/finance-operations-actions";
import { financeOperationsDashboard } from "@/lib/finance-operations-dashboard";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BILL_FILE_SIZE = 25 * 1024 * 1024;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "vendor-bill";
}

function defaultRange() {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = `${now.getUTCFullYear()}-01-01`;
  return { start, end };
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.read");
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const fallback = defaultRange();
    return Response.json(await financeOperationsDashboard({
      business,
      start: url.searchParams.get("start") || fallback.start,
      end: url.searchParams.get("end") || fallback.end,
      salesAdjustmentPercent: numeric(url.searchParams.get("salesAdjustmentPercent")),
      expenseAdjustmentPercent: numeric(url.searchParams.get("expenseAdjustmentPercent")),
      minimumCash: numeric(url.searchParams.get("minimumCash")),
    }));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl: string | null = null;
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "accounting.write");
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const action = clean(form.get("action"), 80);
      if (action !== "create-bill") return Response.json({ error: "Unknown multipart action." }, { status: 400 });
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
      const file = form.get("file");
      let fileName = "";
      let fileType = "";
      let blobPathname = "";
      if (file instanceof File && file.size > 0) {
        if (file.size > MAX_BILL_FILE_SIZE) return Response.json({ error: "Bill files are limited to 25 MB." }, { status: 413 });
        if (!/\.(pdf|csv|xlsx|xls|jpg|jpeg|png|webp)$/i.test(file.name)) {
          return Response.json({ error: "Bill files must be PDF, CSV, Excel, JPG, PNG, or WebP." }, { status: 415 });
        }
        assertConfigured("BLOB_READ_WRITE_TOKEN");
        const pathname = `${business === "Corner Deli" ? "corner-deli" : "tiki"}/vendor-bills/${Date.now()}-${safeFileName(file.name)}`;
        const blob = await put(pathname, file, { access: "private", addRandomSuffix: true });
        uploadedUrl = blob.url;
        blobPathname = blob.pathname;
        fileName = file.name;
        fileType = file.type || "application/octet-stream";
      }
      let lines: BillLineInput[] = [];
      const linesText = clean(form.get("lines"), 20_000);
      if (linesText) {
        const parsed = JSON.parse(linesText) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Bill lines must be an array.");
        lines = parsed.map((line) => {
          const value = line as Record<string, unknown>;
          return {
            inventoryItemId: clean(value.inventoryItemId, 80) || null,
            description: clean(value.description, 300),
            quantity: numeric(value.quantity),
            unit: clean(value.unit, 40),
            unitPrice: numeric(value.unitPrice),
          };
        });
      }
      const result = await createVendorBill({
        business,
        vendor: clean(form.get("vendor"), 180),
        invoiceNumber: clean(form.get("invoiceNumber"), 100),
        invoiceDate: clean(form.get("invoiceDate"), 10),
        dueDate: clean(form.get("dueDate"), 10),
        subtotal: numeric(form.get("subtotal")),
        taxAmount: numeric(form.get("taxAmount")),
        totalAmount: numeric(form.get("totalAmount")),
        category: clean(form.get("category"), 120),
        accountCode: clean(form.get("accountCode"), 20),
        notes: clean(form.get("notes"), 1500),
        fileName,
        contentType: fileType,
        blobUrl: uploadedUrl || "",
        blobPathname,
        lines,
        actor: session.email,
      });
      return Response.json(result, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = clean(body.action, 80);
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });

    if (action === "bill-status") {
      return Response.json(await updateVendorBillStatus({
        business,
        billId: clean(body.billId, 80),
        status: body.status === "Paid" || body.status === "Void" ? body.status : "Open",
        bankTransactionId: clean(body.bankTransactionId, 80) || null,
        actor: session.email,
      }));
    }
    if (action === "create-inventory-item") {
      return Response.json(await createInventoryItem({
        business,
        name: clean(body.name, 180),
        category: clean(body.category, 120),
        baseUnit: clean(body.baseUnit, 40),
        parQuantity: numeric(body.parQuantity),
        currentQuantity: numeric(body.currentQuantity),
        reorderPoint: numeric(body.reorderPoint),
        preferredVendor: clean(body.preferredVendor, 180),
      }));
    }
    if (action === "record-inventory-purchase") {
      return Response.json(await recordInventoryPurchase({
        business,
        inventoryItemId: clean(body.inventoryItemId, 80),
        vendor: clean(body.vendor, 180),
        purchaseDate: clean(body.purchaseDate, 10),
        quantity: numeric(body.quantity),
        unit: clean(body.unit, 40),
        unitPrice: numeric(body.unitPrice),
        source: clean(body.source, 80),
      }));
    }
    if (action === "adjust-inventory") {
      return Response.json(await adjustInventoryQuantity({
        business,
        inventoryItemId: clean(body.inventoryItemId, 80),
        currentQuantity: numeric(body.currentQuantity),
        actor: session.email,
      }));
    }
    if (action === "create-recipe") {
      return Response.json(await createRecipe({
        business,
        productName: clean(body.productName, 220),
        yieldQuantity: numeric(body.yieldQuantity),
        sellingPrice: numeric(body.sellingPrice),
      }));
    }
    if (action === "add-recipe-component") {
      return Response.json(await addRecipeComponent({
        business,
        recipeId: clean(body.recipeId, 80),
        inventoryItemId: clean(body.inventoryItemId, 80),
        quantity: numeric(body.quantity),
        unit: clean(body.unit, 40),
        wastePercent: numeric(body.wastePercent),
      }));
    }
    if (action === "remove-recipe-component") {
      return Response.json(await removeRecipeComponent({
        business,
        recipeId: clean(body.recipeId, 80),
        componentId: clean(body.componentId, 80),
      }));
    }
    if (action === "create-forecast-event") {
      return Response.json(await createForecastEvent({
        business,
        eventDate: clean(body.eventDate, 10),
        description: clean(body.description, 300),
        amount: numeric(body.amount),
        direction: body.direction === "Inflow" ? "Inflow" : "Outflow",
        recurrence: body.recurrence === "Weekly" || body.recurrence === "Monthly" ? body.recurrence : "None",
        actor: session.email,
      }));
    }
    if (action === "delete-forecast-event") {
      return Response.json(await deleteForecastEvent({ business, eventId: clean(body.eventId, 80) }));
    }
    return Response.json({ error: "Unknown finance operations action." }, { status: 400 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
