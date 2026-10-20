import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { GREETER_HOURS, GREETER_HOURS_NOTE, hoursRows } from "@/lib/greeter-hours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GREEN = "#0f1d14";
const INK = "#fdf8ec";
const GOLD = "#f2b632";
const MUTED = "#c9d6c8";

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
 * 404 while no hours are set, so the Pi leaves the slide out. Store network only.
 */
export async function GET() {
  if (GREETER_HOURS.length !== 7) return new Response("No hours set.", { status: 404 });
  const rows = hoursRows(GREETER_HOURS);
  const today = todayIndex();
  const logoSrc = await logoDataUrl();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", padding: "0 130px", background: `radial-gradient(ellipse at 40% 40%, #1f4a2c 0%, ${GREEN} 72%)`, color: INK, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ fontSize: 96, fontWeight: 700, color: GOLD }}>Our hours</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 40 }}>
            {rows.map((row) => {
              const isToday = row.dayIndexes.includes(today);
              return (
                <div key={row.days} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: 1060, padding: "18px 30px", marginBottom: 12, borderRadius: 20, background: isToday ? "rgba(242,182,50,0.16)" : "transparent", border: isToday ? `3px solid ${GOLD}` : "3px solid transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", fontSize: 54, fontWeight: 700 }}>
                    {row.days}
                    {isToday ? <span style={{ marginLeft: 22, padding: "4px 18px", borderRadius: 40, background: GOLD, color: GREEN, fontSize: 30 }}>TODAY</span> : null}
                  </div>
                  <div style={{ fontSize: 54, color: row.time === "Closed" ? MUTED : INK }}>{row.time}</div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 38, color: MUTED, marginTop: 36 }}>{GREETER_HOURS_NOTE}</div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} width={420} height={420} style={{ borderRadius: 210, marginLeft: 40 }} alt="" />
      </div>
    ),
    { width: 1920, height: 1080, headers: { "cache-control": "no-store" } },
  );
}
