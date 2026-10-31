import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { greeterPalette, type GreeterPalette } from "@/lib/greeter-palette";
import { GREETER_HOURS, GREETER_HOURS_NOTE, hoursRows } from "@/lib/greeter-hours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


let logo: Promise<string> | null = null;
const logoDataUrl = () =>
  (logo ??= readFile(path.join(process.cwd(), "public", "corner-deli-logo.png")).then((data) => `data:image/png;base64,${data.toString("base64")}`));

/** Sunday = 0 in store time, matching GREETER_HOURS. */
function todayIndex() {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}

/**
 * The "Our hours" slide for the TV greeter as a 1920×1080 PNG, with today's row picked out.
 * 404 while no hours are set, so the Pi leaves the slide out. ?season= picks holiday colors. Store network only.
 */
export async function GET(request: Request) {
  const P = greeterPalette(new URL(request.url).searchParams.get("season"));
  if (GREETER_HOURS.length !== 7) return new Response("No hours set.", { status: 404 });
  const rows = hoursRows(GREETER_HOURS);
  const today = todayIndex();
  const logoSrc = await logoDataUrl();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", padding: "0 130px", background: `radial-gradient(ellipse at 40% 40%, ${P.glow} 0%, ${P.bg} 72%)`, color: P.ink, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ fontSize: 96, fontWeight: 700, color: P.gold }}>Our hours</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 30 }}>
            {rows.map((row) => {
              const isToday = row.dayIndexes.includes(today);
              return (
                <div key={row.days} style={{ display: "flex", flexDirection: "column", width: 1120, padding: "22px 34px", marginBottom: 18, borderRadius: 22, background: isToday ? P.todayFill : "transparent", border: isToday ? `3px solid ${P.gold}` : "3px solid transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", fontSize: 46, color: P.muted, whiteSpace: "nowrap" }}>
                    {row.days}
                    {isToday ? <span style={{ display: "flex", flexShrink: 0, marginLeft: 24, padding: "4px 20px", borderRadius: 40, background: P.gold, color: P.bg, fontSize: 30, fontWeight: 700 }}>TODAY</span> : null}
                  </div>
                  <div style={{ display: "flex", fontSize: 76, fontWeight: 700, marginTop: 4, whiteSpace: "nowrap", color: row.time === "Closed" ? P.muted : P.ink }}>{row.time}</div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 38, color: P.muted, marginTop: 36 }}>{GREETER_HOURS_NOTE}</div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} width={420} height={420} style={{ borderRadius: 210, marginLeft: 40 }} alt="" />
      </div>
    ),
    { width: 1920, height: 1080, headers: { "cache-control": "no-store" } },
  );
}
