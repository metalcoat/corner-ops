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
    })().catch((error) => {
      aiSchemaPromise = null;
      throw error;
    });
  }

  return aiSchemaPromise;
}
