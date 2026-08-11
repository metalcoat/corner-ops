import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import * as XLSX from "xlsx";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_SHA256 = "43dbf899e67dc07e47c713168afb59a472ee437a0d232f9167663b2450e1f165";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const AUG5_SOURCE = "lve-j_BFxRJLAJzNbVhRPxaRhgxOwY8OGvIHEw5KlQaWof30PyfrGau0abosvXi2fAfvWavvrSs0lxDay6HZ2LduMUDhXHhEqPaYtJ1H9Tm_7BePBMMyTtqsx9e9b1I7uDq0xU7jDDml5Hl_LrFRsttlSvlZJo8qNdHruLuAZvgP95gvfE75057u2bMCEaW6sbvaENZUMdxb4d9INSgUHUyyPpQA7_Cx1bEUqqffHN6gdznyhc7jlMBdodvCP-Ux3zyLUTNopMeutSf8vu4OzHswy3vNXYKaVNDma8Fdwd51U3lcdqz5ZWRgGYguXA3AnjO75bxf0AcE2t6CTBMk_xfH1kQMVIYfaZKhj53cGeY2n9ENPx4x_ibiqBEnWNzXoTnLbhUZpvbQL7ahLWMot9OLwI_6OFdgz7bCbS_9AyEFEIIj-_58jTqwKLeLFjA3IqoPhtYCi4k9Vrz4QKMo2m0yHXEbueJN_HuCVZ1tSRcm5YZBrUfs8JolwVGiL9pWfxCchSaIitP-ulJDNIKch4AN3W8SEO9pi9G1mn2BA8Lbqb2T8s-Ik3xnCL4fCaEpNOQKR3WylCRK5kaNZEo4nMXVYImd36M--LhOi5JHdw11zp5dPOskiUT7AEC3_quJJvK6TYYQTffOkrEs_WBRIWPWuD4G9Z80rydxYVscIl_69JYsBWrZL33nrcpp_KWYDIqMTyL-cfRP5x8O31HVy7CfP_GHFO25cQ7lCP6YtsyDN4UJD8DcrJVg";

function authorized(value: string) {
  const supplied = createHash("sha256").update(value).digest();
  const expected = Buffer.from(TOKEN_SHA256, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function decryptSource(token: string) {
  const payload = Buffer.from(AUG5_SOURCE, "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const key = createHash("sha256").update(token).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function trusted(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST || !/\/order-export\.xlsx$/i.test(url.pathname)) {
    throw new Error("Unexpected Rezku source URL.");
  }
  return url.toString();
}

function norm(value: unknown) {
  return String(value ?? "").trim().replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!authorized(token)) return Response.json({ error: "Unauthorized." }, { status: 401 });

    const sourceUrl = trusted(decryptSource(token));
    const download = await downloadRezkuWorkbook(sourceUrl, "order-export-2026-08-05.xlsx");
    const workbook = XLSX.read(Buffer.from(download.bytes), { type: "buffer", cellDates: true, cellNF: true });
    const target = "bpc006t6";
    const matches: Array<Record<string, unknown>> = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
      const formattedRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
      for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
        const rawRow = rawRows[rowIndex] || [];
        const formattedRow = formattedRows[rowIndex] || [];
        if (![...rawRow, ...formattedRow].some((value) => norm(value) === target)) continue;
        const headerCandidates = [0, 1, 2, 3, 4, 5]
          .map((index) => formattedRows[index] || [])
          .filter((row) => row.some((value) => String(value || "").trim()));
        const header = headerCandidates.sort((a, b) => b.filter(Boolean).length - a.filter(Boolean).length)[0] || [];
        const columns = Array.from({ length: Math.max(header.length, rawRow.length, formattedRow.length) }, (_, index) => ({
          column: XLSX.utils.encode_col(index),
          header: String(header[index] ?? ""),
          raw: rawRow[index] instanceof Date ? (rawRow[index] as Date).toISOString() : rawRow[index],
          formatted: formattedRow[index],
        }));
        matches.push({ sheetName, rowNumber: rowIndex + 1, columns });
      }
    }

    return Response.json({
      ok: true,
      downloadMethod: download.method,
      sheetNames: workbook.SheetNames,
      matches,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
