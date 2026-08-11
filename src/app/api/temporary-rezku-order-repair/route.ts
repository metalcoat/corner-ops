import { createHash, timingSafeEqual } from "node:crypto";
import { importSafeRezkuReport } from "@/lib/safe-rezku-import";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_SHA256 = "43dbf899e67dc07e47c713168afb59a472ee437a0d232f9167663b2450e1f165";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";

function authorized(value: string) {
  const supplied = createHash("sha256").update(value).digest();
  const expected = Buffer.from(TOKEN_SHA256, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function trustedOrderExport(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST || !/\/order-export\.xlsx$/i.test(url.pathname)) {
    throw new Error("Only a trusted Rezku Order Export Excel URL is allowed.");
  }
  return url.toString();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (!authorized(url.searchParams.get("token") || "")) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    const sourceUrl = trustedOrderExport(url.searchParams.get("source") || "");
    const download = await downloadRezkuWorkbook(sourceUrl, "order-export.xlsx");
    const result = await importSafeRezkuReport(
      "order-export.xlsx",
      download.bytes,
      "orders",
      "temporary-payroll-history-repair",
    );
    return Response.json({
      repaired: true,
      batchId: result.batchId,
      rowsRead: result.rowsRead,
      imported: result.imported,
      reportType: result.reportType,
      downloadMethod: download.method,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
