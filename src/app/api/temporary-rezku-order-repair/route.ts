import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { importSafeRezkuReport } from "@/lib/safe-rezku-import";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_SHA256 = "43dbf899e67dc07e47c713168afb59a472ee437a0d232f9167663b2450e1f165";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const ENCRYPTED_SOURCES: Record<string, string> = {
  "2026-08-05": "AL_WCb70RDEg1xOHks1onarKqgKkRTi1NPATGZOZ36v-QoGv1LLunfBLt2DrHWylTglUAQIJbqzuIQUbwt7VjPb1ptbqt9j7UXllkDG5mP9h84kjaT2cJG6KqrIg7IrwNxrJx_mFs9Pm-fHTe6wHqfYm5yIcwQdP6EaAjKmkGYbdsv2njpXSdyH764v5L9-gfclFyS28JTyaOU4Ra7Y15k979ttYFFzWf90wbZthvkA1qwL5CP8jawsesTd5Y7wIs45nqqG5vdiCh2ECiO3aRlfV7WnnfHq1c6d0v6k3aHpgp1KDJzoIKnEsnypxBCnWOSfroLiYWSJsLL8nFyT7vJBhYl95mTbqsSFkaj3_AmLUoU-8TPnOzqwu-BIjPJZNbDwd62nYtz1Sd7Z8kSVI_BN3arQgB6j-VjNrjRrzxab7SxL47q4DmPLJvDz_1admEov1vUNTFRigw-8_AJ38C8LsOznl7UHdyyugJO69gxjdTaXq-bM5GxN2KV29sj9bH9jf-ebQndDVNs6-ZJep6M1y2-CQDwAZs5izKCMRY2LGIT2v70g4a2FJHik5vOK58t7d0Jo1TnNCwCe-q9zTdOH0lyNzj3msBd7kKt6_D4gvYiqMIsqegzp7-PZYNuKISyWq_0HG3qWwjxbJS3FeMCm4Uh8qAN2JkdwKEEsjkypuMnbwUe3BDtghrpYqJQJ_WegDb1h7gqZ3dNxSKy6lkb-yjT4T6rfoW1BznooVk5qknYplwlAHkzfF"
};

function authorized(value: string) {
  const supplied = createHash("sha256").update(value).digest();
  const expected = Buffer.from(TOKEN_SHA256, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function decryptSource(day: string, token: string) {
  const encoded = ENCRYPTED_SOURCES[day];
  if (!encoded) throw new Error("Unknown repair day.");
  const payload = Buffer.from(encoded, "base64url");
  if (payload.length <= 28) throw new Error("Invalid encrypted source.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const key = createHash("sha256").update(token).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
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
    const token = url.searchParams.get("token") || "";
    if (!authorized(token)) return Response.json({ error: "Unauthorized." }, { status: 401 });
    const day = url.searchParams.get("day") || "";
    const sourceUrl = trustedOrderExport(decryptSource(day, token));
    const download = await downloadRezkuWorkbook(sourceUrl, "order-export.xlsx");
    const result = await importSafeRezkuReport(
      "order-export.xlsx",
      download.bytes,
      "orders",
      "temporary-payroll-history-repair",
    );
    return Response.json({
      repaired: true,
      day,
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
