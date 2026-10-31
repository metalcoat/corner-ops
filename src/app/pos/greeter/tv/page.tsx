import type { Metadata } from "next";
import QRCode from "qrcode";
import { greeterFacts } from "@/lib/greeter-facts";
import { greeterPlaylist } from "@/lib/greeter-playlists";
import { storeMonthDay } from "@/lib/menu-board";
import { SEASONS, seasonFor, type SeasonKey } from "@/lib/menu-board-layout";
import GreeterTv from "./greeter-tv";
import "../../menu-board/menu-board.css";
import "./greeter-tv.css";

export const dynamic = "force-dynamic";
// YouTube refuses to play embedded videos when the page sends no referrer (the site default is same-origin).
export const metadata: Metadata = { title: "Welcome | Corner Deli", referrer: "strict-origin-when-cross-origin" };

/**
 * The front-door greeter TV (Fire TV, Fully Kiosk): logo and order QR, weather, a fun fact and
 * the hours take turns, and a spoken welcome interrupts on every walk-in. Follows the menu
 * board's holiday seasons; ?season= previews one, ?nfl_date= previews another day's NFL games.
 */
export default async function GreeterTvPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const asked = typeof params.season === "string" ? params.season : "";
  const season: SeasonKey = asked === "everyday" || SEASONS.some((s) => s.key === asked) ? (asked as SeasonKey) : seasonFor(storeMonthDay());
  const orderUrl = process.env.GREETER_ORDER_URL?.trim() || "https://ordercornerdeli.com";
  const qrSvg = await QRCode.toString(orderUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } });
  return (
    <GreeterTv
      qrSvg={qrSvg}
      orderUrl={orderUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
      season={season}
      followSeason={!asked}
      ribbon={SEASONS.find((s) => s.key === season)?.ribbon ?? ""}
      factCount={greeterFacts(season).length}
      playlist={greeterPlaylist(season)}
      nflDate={typeof params.nfl_date === "string" ? params.nfl_date : null}
    />
  );
}
