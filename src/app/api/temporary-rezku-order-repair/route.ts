import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { importSafeRezkuReport } from "@/lib/safe-rezku-import";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_SHA256 = "43dbf899e67dc07e47c713168afb59a472ee437a0d232f9167663b2450e1f165";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const ENCRYPTED_SOURCES: Record<string, string> = {
  "2026-08-05": "AL_WCb70RDEg1xOHks1onarKqgKkRTi1NPATGZOZ36v-QoGv1LLunfBLt2DrMlytkMkKRdvxVSsEyIZTTTbeyGpKPkpouBoeJOjpbuKB3imKHfZwXiXQGYJx9CweuT2sNx1fI9BKhkxjAEFMcLy4OR7Xdv3GIuVQ9E4SvB09OwsZ0n7-WInXeSdYzdcVtsNDkLXQ7_pAvlCROJi8H0qcAzoVYGwaIU3hZqdWwA9pQuFfkDZAkKaIcuFQLM9n4qDrntXZVJqc96NWaYaq-azNqT5VQ4JpWZ-EzIGHDy9_4qGuqJt_Ipt0buurMJd_H8gUfovXpWhZd4XtbsIuJb7bH4WBOCSqJOEOAmuoNWfxopLs_eiDpUmtfZYbt7RIJeQhqFCvPwaEXWfiJO0ZTdnGnKIfTMxR8PnymR33xiPwA2_QPdZKBdANxzo0RAIiB6kvLACT8fiDZVTBxZeU8ioi3JUk0vP1oqFk0lvqzuAfeFmGOaoDn9FQ7lkHvneE8Mn9CGIacTvrdvud0QqMr92cpqfN-2N6o0RPcfUvDeOt8RBAN3iNyymSjFaQvaYWkhZWUz_2jHtAOuGtJXunlwRYbueMHGJpHuPPKbNuDjTb4dvThc8aJt83TLBdBxQxcjNvRDQosatuyBwzuIJVOgS-f2_4bQYmbTGtljoBJ8DMEjXc5B7-z5xGmnZigB33rfVOd_c_cIbjhfP0kHO56PI-I2zqRk1HfWUk0qSJMsFo9Na7QgcWp5JyPOivMHvuDQBUBNxYat_JVTnZknrI0n46N84c55QvtSOFVNPbkFu_QZosW85kDhEKXaycU1GmuCEPsPtNxmT6p5mTj2dB0k4ncZKAO0kjQd9ZSVVZ0hRl24O8XaEYTg3NoAyNWUcHiwbMvgFdKlBJA"
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
