import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const apkPath = "/data/uploads/mobile-builds/CornerDeliPOS.apk";

export async function GET() {
  try {
    const apk = await readFile(apkPath);

    return new Response(apk, {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Disposition": 'attachment; filename="CornerDeliPOS.apk"',
        "Content-Length": String(apk.byteLength),
        "Content-Type": "application/vnd.android.package-archive",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "The Android app is temporarily unavailable." }, { status: 404 });
  }
}
