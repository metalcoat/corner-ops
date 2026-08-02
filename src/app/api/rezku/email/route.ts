import { timingSafeEqual } from "node:crypto";
import { importRezkuReport } from "@/lib/operations";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const expected = process.env.REZKU_INGEST_SECRET?.trim();
    if (!expected) {
      return Response.json({ error: "Rezku email ingestion is not configured." }, { status: 503 });
    }
    const supplied = request.headers.get("x-rezku-ingest-secret") || "";
    if (!safeEqual(supplied, expected)) {
      return Response.json({ error: "Invalid ingestion credentials." }, { status: 401 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "Missing Rezku report file." }, { status: 400 });
    }
    if (file.size > 25 * 1024 * 1024) {
      return Response.json({ error: "Rezku reports are limited to 25 MB." }, { status: 413 });
    }
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      return Response.json({ error: "Rezku ingestion accepts Excel reports only." }, { status: 415 });
    }

    const result = await importRezkuReport(
      file.name,
      await file.arrayBuffer(),
      String(form.get("reportType") || "") || undefined,
      "Rezku Gmail Bridge",
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
