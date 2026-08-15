import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let promise: Promise<void> | null = null;

export function ensureOrderingGiftCardSchema(): Promise<void> {
  if (!promise) promise = (async () => {
    await ensureOrderingAccountSchema();
    await ensureOrderingPosSchema();
    const sql = getSql();
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS card_number_hash TEXT`;
    await sql`UPDATE ordering_gift_cards SET card_number_hash=token_hash WHERE card_number_hash IS NULL`;
    await sql`ALTER TABLE ordering_gift_cards ALTER COLUMN card_number_hash SET NOT NULL`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS masked_number TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS pin_verifier TEXT`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS current_balance_cents INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS deactivation_reason TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS replaced_by_card_id UUID REFERENCES ordering_gift_cards(id)`;
    await sql`ALTER TABLE ordering_gift_cards ADD COLUMN IF NOT EXISTS source_reference TEXT`;
    await sql`ALTER TABLE ordering_gift_cards ADD CONSTRAINT ordering_gift_cards_balance_nonnegative CHECK (current_balance_cents >= 0) NOT VALID`.catch(() => undefined);
    await sql`ALTER TABLE ordering_gift_cards VALIDATE CONSTRAINT ordering_gift_cards_balance_nonnegative`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_cards_number_hash_idx ON ordering_gift_cards(business,card_number_hash)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_cards_source_idx ON ordering_gift_cards(business,source_reference) WHERE source_reference IS NOT NULL`;

    await sql`ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS business TEXT`;
    await sql`UPDATE ordering_gift_card_ledger ledger SET business=card.business FROM ordering_gift_cards card WHERE ledger.gift_card_id=card.id AND ledger.business IS NULL`;
    await sql`ALTER TABLE ordering_gift_card_ledger ALTER COLUMN business SET NOT NULL`;
    await sql`ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS balance_after_cents INTEGER`;
    await sql`ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS operation_key TEXT`;
    await sql`ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS related_entry_id UUID REFERENCES ordering_gift_card_ledger(id)`;
    await sql`ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS approved_by TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_gift_card_ledger ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
    await sql`ALTER TABLE ordering_gift_card_ledger DROP CONSTRAINT IF EXISTS ordering_gift_card_ledger_entry_type_check`;
    await sql`ALTER TABLE ordering_gift_card_ledger ADD CONSTRAINT ordering_gift_card_ledger_entry_type_check CHECK(entry_type IN ('initial_load','issue','redeem','reload','refund','manager_adjustment','adjustment','expire','reversal','replacement_transfer_in','replacement_transfer_out','import_opening_balance'))`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_card_ledger_operation_idx ON ordering_gift_card_ledger(business,operation_key) WHERE operation_key IS NOT NULL`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_gift_card_ledger_reversal_idx ON ordering_gift_card_ledger(related_entry_id) WHERE entry_type='reversal'`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_gift_card_ledger_business_created_idx ON ordering_gift_card_ledger(business,created_at DESC)`;

    await sql`CREATE OR REPLACE FUNCTION ordering_gift_card_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Gift card ledger entries are immutable'; END $$`;
    await sql`DROP TRIGGER IF EXISTS ordering_gift_card_ledger_immutable_trigger ON ordering_gift_card_ledger`;
    await sql`CREATE TRIGGER ordering_gift_card_ledger_immutable_trigger BEFORE UPDATE OR DELETE ON ordering_gift_card_ledger FOR EACH ROW EXECUTE FUNCTION ordering_gift_card_ledger_immutable()`;
  })().catch((error) => { promise = null; throw error; });
  return promise;
}
