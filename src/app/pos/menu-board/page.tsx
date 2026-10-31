import type { Metadata } from "next";
import QRCode from "qrcode";
import { MENU_LAYOUT_VERSION, menuBoard } from "@/lib/menu-board";
import { SEASONS, type SeasonKey } from "@/lib/menu-board-layout";
import MenuBoard from "./menu-board";
import "./menu-board.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Menu | Corner Deli" };

/**
 * The menu TVs (Fire TV kiosk browser, or a Pi): /pos/menu-board?tv=1..3. Prices and sold-out
 * marks come from the POS and refresh every minute; screens, promos and seasons are set in
 * src/lib/menu-board-layout.ts. ?season= previews a holiday theme; ?motion=low calms a slow TV.
 */
export default async function MenuBoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const tv = Number(params.tv) || 1;
  const asked = typeof params.season === "string" ? params.season : "";
  const season = asked === "everyday" || SEASONS.some((s) => s.key === asked) ? (asked as SeasonKey) : undefined;
  const orderUrl = process.env.GREETER_ORDER_URL?.trim() || "https://ordercornerdeli.com";
  const qrSvg = await QRCode.toString(orderUrl, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } });
  const board = await menuBoard(tv, season);
  return <MenuBoard initial={board} layout={MENU_LAYOUT_VERSION} tv={tv} season={season ?? null} qrSvg={qrSvg} lowMotion={params.motion === "low"} />;
}
