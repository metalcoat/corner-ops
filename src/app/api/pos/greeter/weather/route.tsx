import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { greeterPalette, type GreeterPalette } from "@/lib/greeter-palette";
import { greeterWeather } from "@/lib/greeter-weather";
import type { WeatherDay } from "@/lib/greeter-weather-format";
import { CARD_ICON, CARD_WIDTH, CARDS, HERO, WEATHER_SLIDE } from "@/lib/greeter-weather-layout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


let logo: Promise<string> | null = null;
const logoDataUrl = () =>
  (logo ??= readFile(path.join(process.cwd(), "public", "corner-deli-logo.png")).then((data) => `data:image/png;base64,${data.toString("base64")}`));

const degrees = (value: number | null) => (value === null ? "--" : `${value}°`);

function DayCard({ day, P }: { day: WeatherDay; P: GreeterPalette }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: CARD_WIDTH, height: CARDS.height, padding: "32px 36px", borderRadius: 28, background: "rgba(255,255,255,0.08)", border: "2px solid rgba(255,255,255,0.16)" }}>
      {/* The top-right corner (CARD_ICON square) is left empty for the Pi's animated icon. */}
      <div style={{ display: "flex", flexDirection: "column", width: CARD_WIDTH - CARD_ICON - 90, height: CARD_ICON - 24 }}>
        <div style={{ fontSize: 46, fontWeight: 700, color: P.gold }}>{day.name}</div>
        <div style={{ display: "flex", fontSize: 32, color: P.muted, marginTop: 10, lineHeight: 1.2, overflow: "hidden" }}>{day.forecast}</div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: 14 }}>
        <span style={{ fontSize: 80, fontWeight: 700, color: P.ink }}>{degrees(day.high)}</span>
        <span style={{ fontSize: 46, color: P.muted, marginLeft: 18 }}>{degrees(day.low)}</span>
      </div>
      <div style={{ fontSize: 30, color: P.muted, marginTop: 6 }}>{day.rainChance ? `${day.rainChance}% chance of rain` : " "}</div>
    </div>
  );
}

/**
 * The weather slide for the TV greeter (Raspberry Pi, tools/greeter-pi), as a 1920×1080
 * PNG: Ogdensburg now, today's high and low, and the next three days from weather.gov.
 * The sky beside the temperature and a corner of each card are left plain: the Pi draws
 * animated weather there (see greeter-weather-layout.ts). ?season= picks holiday colors. Store network only.
 */
export async function GET(request: Request) {
  const P = greeterPalette(new URL(request.url).searchParams.get("season"));
  const [weather, logoSrc] = await Promise.all([greeterWeather(), logoDataUrl()]);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: `radial-gradient(ellipse at 50% 30%, ${P.glow} 0%, ${P.bg} 72%)`, color: P.ink, fontFamily: "sans-serif" }}>
        <div style={{ position: "absolute", left: 90, top: 60, display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={120} height={120} style={{ borderRadius: 60 }} alt="" />
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 32 }}>
            <div style={{ fontSize: 58, fontWeight: 700 }}>Ogdensburg weather</div>
            <div style={{ fontSize: 30, color: P.muted }}>{weather ? `National Weather Service · updated ${time.format(new Date(weather.updatedAt))}` : "National Weather Service"}</div>
          </div>
        </div>
        {weather ? (
          <>
            <div style={{ position: "absolute", left: HERO.left, top: HERO.top, width: HERO.width, display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 220, fontWeight: 700, lineHeight: 1, color: P.gold }}>{degrees(weather.now.temperature)}</div>
              <div style={{ display: "flex", flexDirection: "column", marginLeft: 50, flex: 1 }}>
                <div style={{ fontSize: 58, fontWeight: 700, lineHeight: 1.1 }}>{weather.now.conditions || weather.today.forecast}</div>
                <div style={{ fontSize: 40, color: P.muted, marginTop: 14 }}>
                  {weather.today.high !== null ? `High ${degrees(weather.today.high)} · Low ${degrees(weather.today.low)}` : `Tonight: low ${degrees(weather.today.low)}`}
                </div>
                {weather.today.rainChance ? <div style={{ fontSize: 34, color: P.muted, marginTop: 8 }}>{`${weather.today.rainChance}% chance of rain today`}</div> : null}
              </div>
            </div>
            <div style={{ position: "absolute", left: CARDS.left, top: CARDS.top, display: "flex", gap: CARDS.gap }}>
              {weather.next.map((day) => <DayCard key={day.name} day={day} P={P} />)}
            </div>
          </>
        ) : (
          <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 90, fontWeight: 700, color: P.muted }}>Weather unavailable</div>
        )}
      </div>
    ),
    { width: WEATHER_SLIDE.width, height: WEATHER_SLIDE.height, headers: { "cache-control": "no-store" } },
  );
}
