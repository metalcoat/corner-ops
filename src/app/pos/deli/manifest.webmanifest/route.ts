const manifest = {
  id: "/pos/deli",
  name: "Corner Deli POS",
  short_name: "Deli POS",
  description: "Corner Deli point of sale.",
  start_url: "/pos/deli",
  scope: "/pos/deli",
  display: "standalone",
  background_color: "#0f172a",
  theme_color: "#0f172a",
  orientation: "landscape-primary",
  icons: [
    { src: "/corner-ops-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/corner-ops-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
};

export function GET() {
  return Response.json(manifest, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
