import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const apkPath = "/data/uploads/mobile-builds/CornerDeliTeam.apk";

/** The signed Corner Deli employee app for sideloading (tools/team-app/README.md). */
export async function GET() {
  try {
    const apk = await readFile(apkPath);
    return new Response(apk, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="CornerDeli.apk"',
        "Content-Length": String(apk.byteLength),
        "Content-Type": "application/vnd.android.package-archive",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "The Corner Deli app hasn't been published yet." }, { status: 404 });
  }
}
