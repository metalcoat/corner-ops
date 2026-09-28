import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { siteBrandForHost } from "@/lib/site-brand";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const brand = siteBrandForHost((await headers()).get("host") || "");
  const iconSizes = brand.icon.endsWith(".png") ? "512x512" : "any";
  const iconType = brand.icon.endsWith(".png") ? "image/png" : "image/svg+xml";
  return {
    id: "/app",
    name: brand.name,
    short_name: brand.name,
    description: brand.teamHost ? `${brand.name} team messages, schedules, and employee information.` : "Messaging, schedules, time, payroll, documents, and operations for Corner Deli and Tiki.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    orientation: "portrait-primary",
    icons: [
      {
        src: brand.icon,
        sizes: iconSizes,
        type: iconType,
        purpose: "any",
      },
      {
        src: brand.icon,
        sizes: iconSizes,
        type: iconType,
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: brand.teamHost ? "Team messages" : "Owner messages",
        short_name: "Messages",
        description: `Open ${brand.name} messaging.`,
        url: "/ops/messages",
        icons: [{ src: brand.icon, sizes: iconSizes, type: iconType }],
      },
      {
        name: "Employee portal",
        short_name: "Employee",
        description: "Open the employee schedule and messaging portal.",
        url: "/employee",
        icons: [{ src: brand.icon, sizes: iconSizes, type: iconType }],
      },
    ],
  };
}
