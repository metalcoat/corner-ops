const manifest = {
  id: "/display/deli",
  name: "Corner Deli Customer Display",
  short_name: "Deli Display",
  description: "Corner Deli customer-facing order and checkout display.",
  start_url: "/display/deli",
  scope: "/display/deli",
  display: "standalone",
  background_color: "#f4efe5",
  theme_color: "#15232c",
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
