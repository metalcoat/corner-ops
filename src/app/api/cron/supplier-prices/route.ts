import { timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureSupplierCostSchema, importPrices, ingestCatalog, recordPriceSync, SupplierCostError, type CatalogProduct } from "@/lib/ordering-supplier-costs";

export const runtime = "nodejs";
export const maxDuration = 120;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Daily supplier price feed. The price job on the store server (a file-drop
 * folder or a supplier's site) posts either the raw export text or parsed
 * products here:
 *   { "supplier": "Sysco", "csv": "<export text>" }
 *   { "supplier": "US Foods", "products": [{ "sku", "description", "packQuantity", "packUnit", "priceCents" }] }
 * Products we already buy get today's price; everything lands in the catalog
 * for "Find products".
 */
export async function POST(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    await ensureSupplierCostSchema();
    const body = (await request.json()) as { supplier?: string; csv?: string; products?: CatalogProduct[]; source?: string; status?: string; message?: string };
    const name = String(body.supplier || "").trim();
    const supplier = (await getSql()`SELECT id FROM ordering_inventory_suppliers WHERE business='Corner Deli' AND (lower(name)=lower(${name}) OR id::text=${name}) LIMIT 1`)[0];
    if (!supplier) return Response.json({ error: `No supplier named "${name}".` }, { status: 404 });
    const statuses = ["ok", "needs_login", "needs_code", "no_products", "failed"] as const;
    // The website price job reports a sign-in or page problem without any prices.
    if (body.status && body.status !== "ok" && typeof body.csv !== "string") {
      const status = statuses.find((s) => s === body.status) ?? "failed";
      await recordPriceSync(String(supplier.id), { status, message: String(body.message || "") });
      return Response.json({ recorded: status });
    }
    if (typeof body.csv === "string") {
      try {
        const result = await importPrices(String(supplier.id), body.csv);
        if (body.source === "website")
          await recordPriceSync(String(supplier.id), { status: "ok", message: `${result.priceChanges} price change${result.priceChanges === 1 ? "" : "s"}, ${result.offersUpdated} of our items updated`, products: result.catalog });
        return Response.json(result);
      } catch (error) {
        if (body.source === "website" && error instanceof SupplierCostError) await recordPriceSync(String(supplier.id), { status: "no_products", message: error.message });
        throw error;
      }
    }
    if (Array.isArray(body.products)) return Response.json(await ingestCatalog(String(supplier.id), body.products, String(body.source || "feed").slice(0, 40)));
    return Response.json({ error: "Send csv or products." }, { status: 400 });
  } catch (error) {
    if (error instanceof SupplierCostError) return Response.json({ error: error.message }, { status: 409 });
    console.error(error);
    return Response.json({ error: "Supplier prices could not be saved." }, { status: 500 });
  }
}
