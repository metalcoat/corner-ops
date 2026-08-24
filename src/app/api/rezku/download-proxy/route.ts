import { fetchTrustedRezkuWorkbook, trustedRezkuWorkbookUrl } from "@/lib/rezku-trusted-fetch";

const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function clean(value: unknown, max = 240): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization") || "";
  if (!secret || !safeEqual(authorization, `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const body = await request.json() as { url?: string; fileName?: string };
    const rawUrl = trustedRezkuWorkbookUrl(String(body.url || ""));
    const fileName = clean(body.fileName, 255) || "rezku-report.xlsx";
    const response = await fetchTrustedRezkuWorkbook(rawUrl, {
      method: "GET",
      cache: "no-store",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://mail.google.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const responseText = /text|json|xml|html/i.test(contentType)
        ? clean(await response.text().catch(() => ""), 300)
        : "";
      return Response.json({
        error: `Rezku Edge download returned HTTP ${response.status}.`,
        diagnostic: {
          server: clean(response.headers.get("server"), 80),
          cache: clean(response.headers.get("x-cache") || response.headers.get("cf-cache-status"), 100),
          contentType: clean(contentType, 100),
          response: responseText,
        },
      }, { status: response.status });
    }

    const headers = new Headers();
    headers.set("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${fileName.replaceAll('"', "")}"`);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Rezku-Download-Method", "edge-browser-proxy");
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
