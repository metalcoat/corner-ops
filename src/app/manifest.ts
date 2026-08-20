import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Corner Ops",
    short_name: "Corner Ops",
    description: "Messaging, schedules, time, payroll, documents, and operations for Corner Deli and Tiki.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/corner-ops-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/corner-ops-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Owner messages",
        short_name: "Messages",
        description: "Open Corner Ops owner messaging.",
        url: "/ops/messages",
        icons: [{ src: "/corner-ops-icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      {
        name: "Employee portal",
        short_name: "Employee",
        description: "Open the employee schedule and messaging portal.",
        url: "/employee",
        icons: [{ src: "/corner-ops-icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      {
        name: "My deliveries",
        short_name: "Deliveries",
        description: "Open assigned Corner Deli deliveries.",
        url: "/employee/deliveries",
        icons: [{ src: "/corner-ops-icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
    ],
  };
}
