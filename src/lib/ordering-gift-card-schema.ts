import { getSql } from "@/lib/db";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let promise: Promise<void> | null = null;

export function ensureOrderingGiftCardSchema(): Promise<void> {
  if (!promise) promise = (async () => {
    await ensureOrderingAccountSchema();
    await ensureOrderingPosSchema();
    const sql = getSql();
    await sql`UPDATE ordering_gift_cards SET card_number_hash=token_hash WHERE card_number_hash IS NULL`;
    await sql`UPDATE ordering_gift_card_ledger ledger SET business=card.business FROM ordering_gift_cards card WHERE ledger.gift_card_id=card.id AND ledger.business IS NULL`;
  })().catch((error) => { promise = null; throw error; });
  return promise;
}
