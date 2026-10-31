/**
 * Colors for the greeter's server-drawn slides (weather, fun fact, hours), matching the menu
 * board's holiday seasons. Anything other than a known season gets the everyday green.
 */
export type GreeterPalette = { bg: string; glow: string; ink: string; gold: string; muted: string; todayFill: string };

const PALETTES: Record<string, GreeterPalette> = {
  everyday: { bg: "#0f1d14", glow: "#1f4a2c", ink: "#fdf8ec", gold: "#f2b632", muted: "#c9d6c8", todayFill: "rgba(242,182,50,0.16)" },
  halloween: { bg: "#050208", glow: "#4a1a6b", ink: "#fdf8ec", gold: "#ff8a1f", muted: "#d3c0e0", todayFill: "rgba(255,138,31,0.18)" },
  thanksgiving: { bg: "#1e1008", glow: "#5a2e12", ink: "#fdf8ec", gold: "#f4b43a", muted: "#d9bfa0", todayFill: "rgba(244,180,58,0.16)" },
  christmas: { bg: "#0a1a10", glow: "#1c4a30", ink: "#fdf8ec", gold: "#f2d27a", muted: "#c8dccb", todayFill: "rgba(242,210,122,0.16)" },
};

export function greeterPalette(season: string | null | undefined): GreeterPalette {
  return PALETTES[season ?? ""] ?? PALETTES.everyday;
}
