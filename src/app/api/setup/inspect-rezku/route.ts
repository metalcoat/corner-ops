import { createDecipheriv } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as XLSX from "xlsx";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMPORT_TOKEN = "bUWSZ73mPpsxYTA-WG7baxkguk9-HjhpdS1vzAGC4ys";
const PAYLOAD_KEY = Buffer.from("Id6-TFYoEA2YXDDYNZR0wxyR-K39j5o0PilStA48ye4", "base64url");
const REZKU_HOST = "files.reporting.rezkupos.com";

function decryptPayload(value: string): { url: string } {
  const [nonceText, cipherText] = value.split(".");
  if (!nonceText || !cipherText) throw new Error("Encrypted payload is malformed.");
  const nonce = Buffer.from(nonceText, "base64url");
  const combined = Buffer.from(cipherText, "base64url");
  const encrypted = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", PAYLOAD_KEY, nonce);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(gunzipSync(compressed).toString("utf8")) as { url: string };
}

export async function GET(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== "preview") return Response.json({ error: "Preview only." }, { status: 403 });
    const url = new URL(request.url);
    if (url.searchParams.get("token") !== IMPORT_TOKEN) return Response.json({ error: "Invalid token." }, { status: 403 });
    const payload = url.searchParams.get("payload");
    if (!payload) throw new Error("Encrypted payload is required.");
    const input = decryptPayload(payload);
    const reportUrl = new URL(input.url);
    if (reportUrl.protocol !== "https:" || reportUrl.hostname !== REZKU_HOST) throw new Error("Untrusted report URL.");
    const response = await fetch(reportUrl, { redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const workbook = XLSX.read(await response.arrayBuffer(), { type: "array", cellDates: true });
    return Response.json({
      sheets: workbook.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, raw: false }).slice(0, 25),
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}
