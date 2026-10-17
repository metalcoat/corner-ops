import type { Business } from "@/lib/types";

const PRODUCTION_TEAM_URLS: Record<Business, string> = {
  "Corner Deli": "https://team.ordercornerdeli.com",
  Tiki: "https://team.atthedocks.com",
};

export function publicTeamBaseUrl(business: Business): string {
  if (process.env.APP_ENV === "production" || process.env.VERCEL_ENV === "production") return PRODUCTION_TEAM_URLS[business];

  const configured = process.env.EMPLOYEE_APP_URL?.trim() || process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/(?:employee)?\/?$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  return vercel ? `https://${vercel.replace(/\/$/, "")}` : "";
}

export function publicEmployeeHubUrl(business: Business): string {
  const base = publicTeamBaseUrl(business);
  return base ? `${base}/employee?business=${encodeURIComponent(business)}` : "";
}
