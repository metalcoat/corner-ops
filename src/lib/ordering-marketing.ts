import { randomBytes, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { normalizeCallerPhone, type OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingMarketingSchema } from "@/lib/ordering-marketing-schema";

export type MarketingInboundAction = "signup" | "confirm" | "stop" | "help" | "none";

export function classifyMarketingInbound(message: string, signupKeyword = "DELI", confirmationKeyword = "YES"): MarketingInboundAction {
  const value = message.trim().toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(value)) return "stop";
  if (value === "HELP" || value === "INFO") return "help";
  if (value === signupKeyword.trim().toUpperCase()) return "signup";
  if (value === confirmationKeyword.trim().toUpperCase()) return "confirm";
  return "none";
}

export function buildSignupConfirmation(business: OrderingBusiness): string {
  return `${business} deals: Reply YES to confirm marketing texts. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.`;
}

export function buildOptInConfirmed(business: OrderingBusiness): string {
  return `You're signed up for ${business} deals. Msg frequency varies. Reply STOP to opt out, HELP for help.`;
}

export function buildOptOutConfirmed(business: OrderingBusiness): string {
  return `You've been unsubscribed from ${business} marketing texts. No more promotional messages will be sent.`;
}

export function buildHelpResponse(business: OrderingBusiness): string {
  return `${business} marketing texts. Reply STOP to opt out. For ordering or account help, contact the store directly.`;
}

export async function recordMarketingInbound(input: {
  business: OrderingBusiness;
  phone: string;
  message: string;
  source?: string;
  disclosureSnapshot?: string;
}): Promise<{ action: MarketingInboundAction; responseText: string }> {
  await ensureOrderingMarketingSchema();
  const sql = getSql();
  const phone = normalizeCallerPhone(input.phone);
  if (!phone) throw new Error("A valid phone number is required.");

  const settings = (await sql`
    SELECT signup_keyword, confirmation_keyword
    FROM ordering_marketing_settings
    WHERE business = ${input.business}
    LIMIT 1
  `) as Array<{ signup_keyword: string; confirmation_keyword: string }>;
  const signupKeyword = settings[0]?.signup_keyword || (input.business === "Corner Deli" ? "DELI" : "TIKI");
  const confirmationKeyword = settings[0]?.confirmation_keyword || "YES";
  const action = classifyMarketingInbound(input.message, signupKeyword, confirmationKeyword);
  if (action === "none") return { action, responseText: "" };

  const existing = (await sql`
    SELECT id, status
    FROM ordering_marketing_subscriptions
    WHERE business = ${input.business} AND normalized_phone = ${phone}
    LIMIT 1
  `) as Array<{ id: string; status: string }>;

  let subscriptionId = existing[0]?.id || randomUUID();
  const source = input.source || "sms_keyword";
  const disclosure = input.disclosureSnapshot || "";

  if (action === "signup") {
    await sql`
      INSERT INTO ordering_marketing_subscriptions (
        id, business, normalized_phone, status, consent_source, disclosure_snapshot, requested_at, updated_at
      ) VALUES (
        ${subscriptionId}, ${input.business}, ${phone}, 'pending', 'sms_keyword', ${disclosure}, NOW(), NOW()
      )
      ON CONFLICT (business, normalized_phone) DO UPDATE SET
        status = 'pending',
        consent_source = 'sms_keyword',
        disclosure_snapshot = EXCLUDED.disclosure_snapshot,
        requested_at = NOW(),
        confirmed_at = NULL,
        opted_out_at = NULL,
        updated_at = NOW()
      RETURNING id
    `;
    const row = (await sql`SELECT id FROM ordering_marketing_subscriptions WHERE business = ${input.business} AND normalized_phone = ${phone} LIMIT 1`) as Array<{ id: string }>;
    subscriptionId = row[0].id;
    await sql`
      INSERT INTO ordering_marketing_consent_events (id, subscription_id, event_type, source, disclosure_snapshot, evidence)
      VALUES (${randomUUID()}, ${subscriptionId}, 'signup_requested', ${source}, ${disclosure}, CAST(${JSON.stringify({ inbound: input.message })} AS jsonb))
    `;
    return { action, responseText: buildSignupConfirmation(input.business) };
  }

  if (!existing[0] && action !== "stop") {
    return { action, responseText: action === "help" ? buildHelpResponse(input.business) : buildSignupConfirmation(input.business) };
  }

  if (!existing[0] && action === "stop") {
    await sql`
      INSERT INTO ordering_marketing_subscriptions (
        id, business, normalized_phone, status, consent_source, opted_out_at
      ) VALUES (${subscriptionId}, ${input.business}, ${phone}, 'opted_out', 'sms_keyword', NOW())
    `;
  }

  if (action === "confirm") {
    if (existing[0]?.status !== "pending" && existing[0]?.status !== "opted_out") {
      return { action, responseText: buildOptInConfirmed(input.business) };
    }
    await sql`
      UPDATE ordering_marketing_subscriptions
      SET status = 'active', confirmed_at = NOW(), opted_out_at = NULL, updated_at = NOW()
      WHERE id = ${subscriptionId}
    `;
    await sql`
      INSERT INTO ordering_marketing_consent_events (id, subscription_id, event_type, source, disclosure_snapshot, evidence)
      VALUES (${randomUUID()}, ${subscriptionId}, ${existing[0]?.status === "opted_out" ? "resubscribed" : "opt_in_confirmed"}, ${source}, ${disclosure}, CAST(${JSON.stringify({ inbound: input.message })} AS jsonb))
    `;
    return { action, responseText: buildOptInConfirmed(input.business) };
  }

  if (action === "stop") {
    const row = (await sql`SELECT id FROM ordering_marketing_subscriptions WHERE business = ${input.business} AND normalized_phone = ${phone} LIMIT 1`) as Array<{ id: string }>;
    subscriptionId = row[0].id;
    await sql`
      UPDATE ordering_marketing_subscriptions
      SET status = 'opted_out', opted_out_at = NOW(), updated_at = NOW()
      WHERE id = ${subscriptionId}
    `;
    await sql`
      INSERT INTO ordering_marketing_consent_events (id, subscription_id, event_type, source, evidence)
      VALUES (${randomUUID()}, ${subscriptionId}, 'opt_out', ${source}, CAST(${JSON.stringify({ inbound: input.message })} AS jsonb))
    `;
    return { action, responseText: buildOptOutConfirmed(input.business) };
  }

  await sql`
    INSERT INTO ordering_marketing_consent_events (id, subscription_id, event_type, source, evidence)
    VALUES (${randomUUID()}, ${subscriptionId}, 'help_requested', ${source}, CAST(${JSON.stringify({ inbound: input.message })} AS jsonb))
  `;
  return { action, responseText: buildHelpResponse(input.business) };
}

function offerCode(): string {
  return `DELI-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function queueEligibleInactivityWinbacks(input: {
  business: OrderingBusiness;
  now?: Date;
  limit?: number;
}): Promise<{ queued: number; skipped: number }> {
  await ensureOrderingMarketingSchema();
  const sql = getSql();
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));

  const campaigns = (await sql`
    SELECT id, inactivity_days, message_template, offer_type, offer_item_id, offer_label,
           offer_amount_cents, offer_percent_bps, offer_valid_days
    FROM ordering_marketing_campaigns
    WHERE business = ${input.business} AND active = TRUE AND trigger_type = 'inactivity'
    ORDER BY created_at
  `) as Array<{
    id: string;
    inactivity_days: number;
    message_template: string;
    offer_type: string;
    offer_item_id: string | null;
    offer_label: string;
    offer_amount_cents: number;
    offer_percent_bps: number;
    offer_valid_days: number;
  }>;

  let queued = 0;
  let skipped = 0;

  for (const campaign of campaigns) {
    const candidates = (await sql`
      SELECT
        sub.id AS subscription_id,
        sub.customer_id,
        sub.normalized_phone,
        last_order.id AS last_order_id,
        last_order.completed_at
      FROM ordering_marketing_subscriptions sub
      JOIN LATERAL (
        SELECT o.id, COALESCE(o.closed_at, o.updated_at) AS completed_at
        FROM ordering_orders o
        WHERE o.business = ${input.business}
          AND o.status = 'completed'
          AND sub.customer_id IS NOT NULL
          AND o.customer_id = sub.customer_id
        ORDER BY COALESCE(o.closed_at, o.updated_at) DESC
        LIMIT 1
      ) last_order ON TRUE
      WHERE sub.business = ${input.business}
        AND sub.status = 'active'
        AND sub.confirmed_at IS NOT NULL
        AND last_order.completed_at <= ${now.toISOString()}::timestamptz - (${campaign.inactivity_days}::text || ' days')::interval
        AND NOT EXISTS (
          SELECT 1
          FROM ordering_marketing_messages msg
          WHERE msg.campaign_id = ${campaign.id}
            AND msg.subscription_id = sub.id
            AND msg.trigger_last_order_id = last_order.id
        )
      ORDER BY last_order.completed_at
      LIMIT ${limit}
    `) as Array<{
      subscription_id: string;
      customer_id: string | null;
      normalized_phone: string;
      last_order_id: string;
      completed_at: string | Date;
    }>;

    for (const candidate of candidates) {
      if (campaign.offer_type === "item_amount_off" && !campaign.offer_item_id) {
        skipped += 1;
        continue;
      }

      const code = offerCode();
      const offerId = randomUUID();
      const expiresAt = new Date(now.getTime() + Math.max(1, campaign.offer_valid_days) * 86_400_000);
      const expiresText = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric" }).format(expiresAt);
      const messageText = campaign.message_template
        .replaceAll("{{code}}", code)
        .replaceAll("{{expires}}", expiresText)
        .replaceAll("{{offer}}", campaign.offer_label);

      await sql`
        INSERT INTO ordering_marketing_offers (
          id, campaign_id, subscription_id, customer_id, code, offer_item_id, offer_label,
          offer_amount_cents, offer_percent_bps, issued_at, expires_at
        ) VALUES (
          ${offerId}, ${campaign.id}, ${candidate.subscription_id}, ${candidate.customer_id}, ${code},
          ${campaign.offer_item_id}, ${campaign.offer_label}, ${campaign.offer_amount_cents}, ${campaign.offer_percent_bps},
          ${now.toISOString()}, ${expiresAt.toISOString()}
        )
      `;
      await sql`
        INSERT INTO ordering_marketing_messages (
          id, campaign_id, subscription_id, offer_id, normalized_phone,
          trigger_last_order_id, trigger_last_order_at, message_text, status, queued_at
        ) VALUES (
          ${randomUUID()}, ${campaign.id}, ${candidate.subscription_id}, ${offerId}, ${candidate.normalized_phone},
          ${candidate.last_order_id}, ${candidate.completed_at}, ${messageText}, 'queued', ${now.toISOString()}
        )
      `;
      queued += 1;
    }
  }

  return { queued, skipped };
}
