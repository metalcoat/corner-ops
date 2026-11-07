import { readFileSync } from "node:fs";

// Which server and which build a POS screen is on, shown small in the POS header and in System status
// (Chris, 2026-11-07: tell prod from dev on the iPad without another menu). The header had "DEV" hard-coded.

export type BuildInfo = { environment: "DEV" | "STAGING" | "PROD"; sha: string; builtAt: string };

function environment(): BuildInfo["environment"] {
  const explicit = String(process.env.APP_ENVIRONMENT || "").trim().toUpperCase();
  if (explicit === "DEV" || explicit === "STAGING" || explicit === "PROD") return explicit;
  if (process.env.LOCAL_DEVELOPMENT === "true") return "DEV";
  const urls = `${process.env.APP_URL || ""} ${process.env.CUSTOMER_APP_URL || ""}`.toLowerCase();
  if (/staging/.test(urls)) return "STAGING";
  if (/\/\/dev\.|-dev\./.test(urls)) return "DEV";
  return "PROD";
}

let builtAt: string | null = null;

export function buildInfo(): BuildInfo {
  // Written by the Dockerfile when the image is built; empty when running outside an image.
  if (builtAt === null) {
    try {
      builtAt = readFileSync("/app/.built-at", "utf8").trim();
    } catch {
      builtAt = "";
    }
  }
  return { environment: environment(), sha: String(process.env.APP_BUILD_SHA || "").trim().slice(0, 7), builtAt };
}

/** "4f55c98 · Nov 7 13:42 UTC", or just the build time when no commit was passed to the build. */
export function buildVersionLabel(info: BuildInfo) {
  const when = info.builtAt ? new Date(info.builtAt) : null;
  const time = when && !Number.isNaN(when.getTime())
    ? `${when.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`
    : "";
  return [info.sha, time].filter(Boolean).join(" · ") || "unknown";
}
