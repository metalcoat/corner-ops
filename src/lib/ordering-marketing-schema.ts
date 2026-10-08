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
        CREATE TABLE IF NOT EXISTS ordering_marketing_settings (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          signup_keyword TEXT NOT NULL DEFAULT 'DELI',
          confirmation_keyword TEXT NOT NULL DEFAULT 'YES',
          quiet_start_local TIME NOT NULL DEFAULT '19:00',
          quiet_end_local TIME NOT NULL DEFAULT '10:00',
          timezone TEXT NOT NULL DEFAULT 'America/New_York',
          sender_key TEXT NOT NULL DEFAULT '',
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        INSERT INTO ordering_marketing_settings (business, enabled, signup_keyword)
        VALUES ('Corner Deli', FALSE, 'DELI'), ('Tiki', FALSE, 'TIKI')
        ON CONFLICT (business) DO NOTHING
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_marketing_subscriptions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
          normalized_phone TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'active', 'opted_out', 'blocked')),
          consent_source TEXT NOT NULL
            CHECK (consent_source IN ('sms_keyword', 'web', 'pos', 'ai_phone', 'other')),
          disclosure_snapshot TEXT NOT NULL DEFAULT '',
          consent_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          confirmed_at TIMESTAMPTZ,
          opted_out_at TIMESTAMPTZ,
          last_marketing_sent_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, normalized_phone)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_subscriptions_active_idx ON ordering_marketing_subscriptions (business, status, last_marketing_sent_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_subscriptions_customer_idx ON ordering_marketing_subscriptions (customer_id, status)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_marketing_consent_events (
          id UUID PRIMARY KEY,
          subscription_id UUID NOT NULL REFERENCES ordering_marketing_subscriptions(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL
            CHECK (event_type IN ('signup_requested', 'opt_in_confirmed', 'opt_out', 'blocked', 'resubscribed', 'help_requested')),
          source TEXT NOT NULL DEFAULT '',
          disclosure_snapshot TEXT NOT NULL DEFAULT '',
          evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_consent_events_subscription_idx ON ordering_marketing_consent_events (subscription_id, created_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_marketing_campaigns (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          trigger_type TEXT NOT NULL DEFAULT 'inactivity'
            CHECK (trigger_type IN ('inactivity', 'manual', 'birthday', 'custom')),
          inactivity_days INTEGER NOT NULL DEFAULT 25 CHECK (inactivity_days >= 1),
          one_per_inactivity_episode BOOLEAN NOT NULL DEFAULT TRUE,
          message_template TEXT NOT NULL,
          offer_type TEXT NOT NULL DEFAULT 'item_amount_off'
            CHECK (offer_type IN ('item_amount_off', 'order_amount_off', 'percent_off', 'none')),
          offer_item_id UUID REFERENCES ordering_menu_items(id) ON DELETE SET NULL,
          offer_label TEXT NOT NULL DEFAULT '',
          offer_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (offer_amount_cents >= 0),
          offer_percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (offer_percent_bps >= 0 AND offer_percent_bps <= 10000),
          offer_valid_days INTEGER NOT NULL DEFAULT 14 CHECK (offer_valid_days >= 1),
          active BOOLEAN NOT NULL DEFAULT FALSE,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_campaigns_active_idx ON ordering_marketing_campaigns (business, active, trigger_type)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_marketing_offers (
          id UUID PRIMARY KEY,
          campaign_id UUID NOT NULL REFERENCES ordering_marketing_campaigns(id) ON DELETE CASCADE,
          subscription_id UUID NOT NULL REFERENCES ordering_marketing_subscriptions(id) ON DELETE CASCADE,
          customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
          code TEXT NOT NULL UNIQUE,
          offer_item_id UUID REFERENCES ordering_menu_items(id) ON DELETE SET NULL,
          offer_label TEXT NOT NULL DEFAULT '',
          offer_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (offer_amount_cents >= 0),
          offer_percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (offer_percent_bps >= 0 AND offer_percent_bps <= 10000),
          issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          redeemed_order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
          redeemed_at TIMESTAMPTZ,
          voided_at TIMESTAMPTZ,
          CHECK (expires_at > issued_at)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_offers_subscription_idx ON ordering_marketing_offers (subscription_id, issued_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_offers_open_idx ON ordering_marketing_offers (expires_at) WHERE redeemed_at IS NULL AND voided_at IS NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_marketing_messages (
          id UUID PRIMARY KEY,
          campaign_id UUID NOT NULL REFERENCES ordering_marketing_campaigns(id) ON DELETE CASCADE,
          subscription_id UUID NOT NULL REFERENCES ordering_marketing_subscriptions(id) ON DELETE CASCADE,
          offer_id UUID REFERENCES ordering_marketing_offers(id) ON DELETE SET NULL,
          normalized_phone TEXT NOT NULL,
          trigger_last_order_id UUID REFERENCES ordering_orders(id) ON DELETE SET NULL,
          trigger_last_order_at TIMESTAMPTZ,
          message_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'suppressed', 'expired')),
          suppression_reason TEXT NOT NULL DEFAULT '',
          provider_message_id TEXT NOT NULL DEFAULT '',
          queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMPTZ,
          delivered_at TIMESTAMPTZ,
          failed_at TIMESTAMPTZ,
          details JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_messages_queue_idx ON ordering_marketing_messages (status, queued_at)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_marketing_messages_subscription_idx ON ordering_marketing_messages (subscription_id, queued_at DESC)`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS ordering_marketing_one_winback_per_order_episode
        ON ordering_marketing_messages (campaign_id, subscription_id, trigger_last_order_id)
        WHERE trigger_last_order_id IS NOT NULL
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
