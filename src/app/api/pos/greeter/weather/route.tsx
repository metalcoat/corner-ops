import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { greeterWeather } from "@/lib/greeter-weather";
import type { WeatherDay } from "@/lib/greeter-weather-format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GREEN = "#0f1d14";
const INK = "#fdf8ec";
const GOLD = "#f2b632";
const MUTED = "#c9d6c8";

let logo: Promise<string> | null = null;
const logoDataUrl = () =>
  (logo ??= readFile(path.join(process.cwd(), "public", "corner-deli-logo.png")).then((data) => `data:image/png;base64,${data.toString("base64")}`));

const degrees = (value: number | null) => (value === null ? "--" : `${value}°`);

function DayCard({ day }: { day: WeatherDay }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "34px 36px", borderRadius: 28, background: "rgba(255,255,255,0.08)", border: "2px solid rgba(255,255,255,0.16)" }}>
      <div style={{ fontSize: 44, fontWeight: 700, color: GOLD }}>{day.name}</div>
      <div style={{ display: "flex", fontSize: 34, color: MUTED, marginTop: 10, height: 92, overflow: "hidden" }}>{day.forecast}</div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: 18 }}>
        <span style={{ fontSize: 76, fontWeight: 700, color: INK }}>{degrees(day.high)}</span>
        <span style={{ fontSize: 44, color: MUTED, marginLeft: 18 }}>{degrees(day.low)}</span>
      </div>
      <div style={{ fontSize: 30, color: MUTED, marginTop: 8 }}>{day.rainChance ? `${day.rainChance}% chance of rain` : " "}</div>
    </div>
  );
}

/**
 * The weather slide for the TV greeter (Raspberry Pi, tools/greeter-pi), as a 1920×1080
 * PNG: Ogdensburg now, today's high and low, and the next three days from weather.gov.
 * Store network only, like the rest of /api/pos.
 */
export async function GET() {
  const [weather, logoSrc] = await Promise.all([greeterWeather(), logoDataUrl()]);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "70px 90px", background: `radial-gradient(ellipse at 50% 30%, #1f4a2c 0%, ${GREEN} 72%)`, color: INK, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={130} height={130} style={{ borderRadius: 65 }} alt="" />
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 34 }}>
            <div style={{ fontSize: 60, fontWeight: 700 }}>Ogdensburg weather</div>
            <div style={{ fontSize: 30, color: MUTED }}>{weather ? `National Weather Service · updated ${time.format(new Date(weather.updatedAt))}` : "National Weather Service"}</div>
          </div>
        </div>
        {weather ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between", marginTop: 40 }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 230, fontWeight: 700, lineHeight: 1, color: GOLD }}>{degrees(weather.now.temperature)}</div>
              <div style={{ display: "flex", flexDirection: "column", marginLeft: 60 }}>
                <div style={{ fontSize: 64, fontWeight: 700 }}>{weather.now.conditions || weather.today.forecast}</div>
                <div style={{ fontSize: 44, color: MUTED, marginTop: 12 }}>
                  {weather.today.high !== null ? `Today: high ${degrees(weather.today.high)} · low ${degrees(weather.today.low)}` : `Tonight: low ${degrees(weather.today.low)}`}
                </div>
                {weather.today.rainChance ? <div style={{ fontSize: 38, color: MUTED, marginTop: 8 }}>{`${weather.today.rainChance}% chance of rain`}</div> : null}
              </div>
            </div>
            <div style={{ display: "flex", gap: 36 }}>
              {weather.next.map((day) => <DayCard key={day.name} day={day} />)}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: 90, fontWeight: 700, color: MUTED }}>Weather unavailable</div>
        )}
      </div>
    ),
    { width: 1920, height: 1080, headers: { "cache-control": "no-store" } },
  );
}
