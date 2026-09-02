import { Resend } from "resend";
import { notifyOwnersOfOperationalPush } from "@/lib/push-notifications";
import type { Business } from "@/lib/types";

type AlertInput = {
  business: Business;
  title: string;
  body: string;
  url: string;
  tag: string;
};

async function deliverEmail(input: AlertInput) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.ALERT_FROM_EMAIL?.trim();
  const to = process.env.ALERT_TO_EMAIL?.trim() || process.env.APP_EMAIL?.trim();
  if (!apiKey || !from || !to) return { configured: false, sent: false };
  const base = process.env.APP_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const pageUrl = base
    ? `${base.startsWith("http") ? base : `https://${base}`}${input.url}`
    : input.url;
  const result = await new Resend(apiKey).emails.send({
    from,
    to,
    subject: input.title,
    text: `${input.body}\n\nReview overtime risk: ${pageUrl}`,
  });
  if (result.error) throw new Error(result.error.message);
  return { configured: true, sent: true, id: result.data?.id || null };
}

export async function notifyOwnersOfOperationalAlert(input: AlertInput) {
  const push = await notifyOwnersOfOperationalPush(input).catch((error) => ({
    attempted: 0,
    delivered: 0,
    failed: 1,
    error: error instanceof Error ? error.message : String(error),
  }));
  const email = push.delivered > 0
    ? { configured: Boolean(process.env.RESEND_API_KEY?.trim()), sent: false, skipped: true }
    : await deliverEmail(input).catch((error) => ({
        configured: true,
        sent: false,
        error: error instanceof Error ? error.message : String(error),
      }));
  return { ...push, email };
}
