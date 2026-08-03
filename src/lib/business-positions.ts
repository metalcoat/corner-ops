import type { Business } from "@/lib/types";

export const CORNER_DELI_POSITIONS = ["Pizza", "Fryer", "Delivery"] as const;
export type CornerDeliPosition = (typeof CORNER_DELI_POSITIONS)[number];

export function positionsForBusiness(business: Business): string[] {
  return business === "Corner Deli" ? [...CORNER_DELI_POSITIONS] : ["Bartender"];
}

export function normalizePosition(business: Business, value: unknown): string {
  const text = String(value ?? "").trim();
  if (business !== "Corner Deli") return text || "Bartender";

  const lower = text.toLowerCase();
  if (lower === "delivery" || /driver|deliver/.test(lower)) return "Delivery";
  if (lower === "fryer" || /fry/.test(lower)) return "Fryer";
  if (lower === "pizza" || /pizza|chef|cook|manager|in-house|in house/.test(lower)) return "Pizza";
  throw new Error("Corner Deli position must be Pizza, Fryer, or Delivery.");
}

export function roleGroupForPosition(business: Business, position: string): "Driver" | "In-House" {
  return business === "Corner Deli" && normalizePosition(business, position) === "Delivery"
    ? "Driver"
    : "In-House";
}
