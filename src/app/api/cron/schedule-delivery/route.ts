import { timingSafeEqual } from "node:crypto";
import { sendOnboardingReminders } from "@/lib/employee-onboarding";
import { processSchedulePublicationDeliveries } from "@/lib/schedule-publication-delivery";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const deliveries = await processSchedulePublicationDeliveries({ limit: 30 });
  // New-hire "setup isn't finished" texts ride along: at most one per person per day, 10 AM-7 PM Eastern.
  const onboardingReminders = await sendOnboardingReminders().catch((error) => {
    console.error("[cron/schedule-delivery] onboarding reminders failed", error);
    return { error: error instanceof Error ? error.message : String(error) };
  });
  return Response.json({ ...deliveries, onboardingReminders });
}
