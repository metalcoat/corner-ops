import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { greeterPalette, type GreeterPalette } from "@/lib/greeter-palette";
import { greeterFacts } from "@/lib/greeter-facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


let logo: Promise<string> | null = null;
const logoDataUrl = () =>
  (logo ??= readFile(path.join(process.cwd(), "public", "corner-deli-logo.png")).then((data) => `data:image/png;base64,${data.toString("base64")}`));

/**
 * One "Did you know?" slide for the TV greeter (tools/greeter-pi) as a 1920×1080 PNG:
 * GET /api/pos/greeter/fact?n=3. ?season= picks holiday colors and that holiday's facts.
 * Store network only, like the rest of /api/pos.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const n = Number(params.get("n") || 0);
  const facts = greeterFacts(params.get("season"));
  const fact = facts[((Number.isInteger(n) ? n : 0) % facts.length + facts.length) % facts.length];
  const P = greeterPalette(params.get("season"));
  const size = fact.text.length > 120 ? 66 : fact.text.length > 80 ? 76 : 88;
  const logoSrc = await logoDataUrl();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 150px", background: `radial-gradient(ellipse at 50% 40%, ${P.glow} 0%, ${P.bg} 72%)`, color: P.ink, fontFamily: "sans-serif", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 56, fontWeight: 700, color: P.gold, letterSpacing: 2 }}>
          <div style={{ width: 84, height: 84, borderRadius: 42, background: P.gold, color: P.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 60, fontWeight: 700, marginRight: 30 }}>?</div>
          {params.get("season") === "halloween" ? "Boo! Did you know?" : "Did you know?"}
        </div>
        <div style={{ display: "flex", fontSize: size, fontWeight: 700, lineHeight: 1.2, marginTop: 50, maxWidth: 1620 }}>{fact.text}</div>
        <div style={{ position: "absolute", left: 150, bottom: 80, display: "flex", fontSize: 34, color: P.muted, letterSpacing: 3 }}>{fact.topic.toUpperCase()}</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} width={130} height={130} style={{ position: "absolute", right: 120, bottom: 60, borderRadius: 65 }} alt="" />
      </div>
    ),
    { width: 1920, height: 1080, headers: { "cache-control": "no-store" } },
  );
}
