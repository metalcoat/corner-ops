import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let marketingSchemaPromise: Promise<void> | null = null;

/**
 * Marketing SMS is deliberately separate from transactional order messaging.
 * A customer being textable for order updates does not make them opted in for
 * promotional messages. Consent and opt-out history are retained as immutable
 * events so the business can prove why a promotional text was sent.
 */
export function ensureOrderingMarketingSchema(): Promise<void> {
  if (!marketingSchemaPromise) {
    marketingSchemaPromise = (async () => {
      await ensureOrderingPosSchema();
      const sql = getSql();

      await sql`
        INSERT INTO ordering_marketing_settings (business, enabled, signup_keyword)
        VALUES ('Corner Deli', FALSE, 'DELI'), ('Tiki', FALSE, 'TIKI')
        ON CONFLICT (business) DO NOTHING
      `;

      // Development seed. It stays inactive until the real Turkey Big Boss
      // menu item is linked after the Rezku menu import and an SMS sender is
      // configured. No promotional texts should leave the system before then.
      await sql`
        INSERT INTO ordering_marketing_campaigns (
          id, business, name, trigger_type, inactivity_days, one_per_inactivity_episode,
          message_template, offer_type, offer_label, offer_amount_cents,
          offer_valid_days, active, created_by
        ) VALUES (
          '93c5d460-01e2-42da-a8bf-39f8a41f2501',
          'Corner Deli',
          '25-day Turkey Big Boss win-back',
          'inactivity',
          25,
          TRUE,
          'Hey, Corner Deli here. We haven''t seen you in a little while. Here''s $3 off a Turkey Big Boss: {{code}}. Expires {{expires}}. Reply STOP to opt out.',
          'item_amount_off',
          'Turkey Big Boss',
          300,
          14,
          FALSE,
          'development-seed'
        )
        ON CONFLICT (business, name) DO NOTHING
      `;
    })().catch((error) => {
      marketingSchemaPromise = null;
      throw error;
    });
  }

  return marketingSchemaPromise;
}
