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
      await sql`INSERT INTO ordering_ai_phone_settings(business) VALUES('Corner Deli'),('Tiki') ON CONFLICT DO NOTHING`;
      await sql`UPDATE ordering_ai_phone_settings SET openai_model=model WHERE provider='openai' AND openai_model='gpt-realtime-1.5' AND model<>''`;
      await sql`UPDATE ordering_ai_phone_settings SET model='gpt-realtime-1.5',updated_by='system:model-rollback',updated_at=NOW() WHERE business='Corner Deli' AND model='gpt-realtime-2.1-mini'`;
    })().catch((error) => {
      aiSchemaPromise = null;
      throw error;
    });
  }

  return aiSchemaPromise;
}
