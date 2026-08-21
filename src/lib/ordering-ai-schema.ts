import { getSql } from "@/lib/db";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";

let aiSchemaPromise: Promise<void> | null = null;

/**
 * AI-call state is kept beside the shared order rather than hidden inside a
 * model prompt. This lets the POS/owner view see which required questions are
 * still unresolved and survive an AI-to-human handoff without losing context.
 */
export function ensureOrderingAiSchema(): Promise<void> {
  if (!aiSchemaPromise) {
    aiSchemaPromise = (async () => {
      await ensureOrderingChannelSchema();
      const sql = getSql();

      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS fulfillment_question_state TEXT NOT NULL DEFAULT 'not_asked'`;
      await sql`ALTER TABLE ordering_call_sessions DROP CONSTRAINT IF EXISTS ordering_call_sessions_fulfillment_question_state_check`;
      await sql`
        ALTER TABLE ordering_call_sessions
        ADD CONSTRAINT ordering_call_sessions_fulfillment_question_state_check
        CHECK (fulfillment_question_state IN ('not_asked', 'asked_unanswered', 'deferred_while_ordering', 'resolved'))
      `;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS deferred_required_fields JSONB NOT NULL DEFAULT '[]'::jsonb`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS last_customer_turn_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS last_ai_turn_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS last_natural_break_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS called_did TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS line_label TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS claimed_by TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS selected_model TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS operating_mode TEXT NOT NULL DEFAULT 'shadow'`;
      await sql`ALTER TABLE ordering_call_sessions DROP CONSTRAINT IF EXISTS ordering_call_sessions_operating_mode_check`;
      await sql`ALTER TABLE ordering_call_sessions ADD CONSTRAINT ordering_call_sessions_operating_mode_check CHECK(operating_mode IN ('shadow','assisted','autonomous'))`;

      await sql`CREATE INDEX IF NOT EXISTS ordering_call_sessions_fulfillment_state_idx ON ordering_call_sessions (business, fulfillment_question_state, updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_ai_tool_events (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          request_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL DEFAULT '',
          tool_name TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          order_id UUID REFERENCES ordering_orders(id),
          customer_id UUID REFERENCES ordering_customers(id),
          outcome TEXT NOT NULL CHECK (outcome IN ('success', 'blocked', 'error')),
          error_code TEXT NOT NULL DEFAULT '',
          input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
          model TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_ai_tool_events_request_idx ON ordering_ai_tool_events (business, request_id)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_ai_tool_events_order_idx ON ordering_ai_tool_events (order_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_ai_tool_events_conversation_idx ON ordering_ai_tool_events (business, conversation_id, created_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_ai_call_events (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          call_id TEXT NOT NULL,
          event_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'system',
          label TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, event_key)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_ai_call_events_call_idx ON ordering_ai_call_events (business, call_id, created_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_ai_phone_settings (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli','Tiki')),
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','assisted','autonomous')),
          model TEXT NOT NULL DEFAULT 'gpt-realtime-2.1-mini',
          max_response_words INTEGER NOT NULL DEFAULT 10 CHECK (max_response_words BETWEEN 2 AND 30),
          max_upsells INTEGER NOT NULL DEFAULT 2 CHECK (max_upsells BETWEEN 0 AND 3),
          vad_eagerness TEXT NOT NULL DEFAULT 'high' CHECK (vad_eagerness IN ('low','medium','high')),
          recording_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          transcript_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (transcript_retention_days BETWEEN 1 AND 365),
          updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`INSERT INTO ordering_ai_phone_settings(business) VALUES('Corner Deli'),('Tiki') ON CONFLICT DO NOTHING`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_call_transcript_segments (
          id UUID PRIMARY KEY, business TEXT NOT NULL, call_id TEXT NOT NULL, event_key TEXT NOT NULL,
          speaker TEXT NOT NULL CHECK (speaker IN ('customer','assistant','system')),
          transcript TEXT NOT NULL, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          confidence NUMERIC(6,5), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          UNIQUE(business,event_key)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_call_transcript_call_idx ON ordering_call_transcript_segments(business,call_id,completed_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_ai_latency_samples (
          id UUID PRIMARY KEY, business TEXT NOT NULL, call_id TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT '',
          metric TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms>=0), model TEXT NOT NULL DEFAULT '',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_ai_latency_call_idx ON ordering_ai_latency_samples(business,call_id,created_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_ai_upsell_events (
          id UUID PRIMARY KEY,business TEXT NOT NULL,call_id TEXT NOT NULL,order_id UUID REFERENCES ordering_orders(id),
          rule_id UUID REFERENCES ordering_upsell_rules(id),offered_item_id UUID REFERENCES ordering_menu_items(id),
          outcome TEXT NOT NULL CHECK(outcome IN ('offered','accepted','declined','skipped')),
          revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK(revenue_cents>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_ai_upsell_call_idx ON ordering_ai_upsell_events(business,call_id,created_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_call_reviews (
          id UUID PRIMARY KEY,business TEXT NOT NULL,call_id TEXT NOT NULL,order_id UUID REFERENCES ordering_orders(id),
          rating TEXT NOT NULL CHECK(rating IN ('good','needs_review','ai_error','customer_error','menu_rule_problem','employee_follow_up')),
          notes TEXT NOT NULL DEFAULT '',expected_order JSONB NOT NULL DEFAULT '{}'::jsonb,ai_order JSONB NOT NULL DEFAULT '{}'::jsonb,
          differences JSONB NOT NULL DEFAULT '[]'::jsonb,reviewed_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(business,call_id)
        )
      `;
    })().catch((error) => {
      aiSchemaPromise = null;
      throw error;
    });
  }

  return aiSchemaPromise;
}
