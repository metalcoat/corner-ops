import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
let promise: Promise<void> | null = null;
export function ensureOrderingTipSchema() {
  if (!promise)
    promise = (async () => {
      await ensureOrderingPosSchema();
      const sql = getSql();
      await sql`INSERT INTO ordering_tip_policies(business)VALUES('Corner Deli') ON CONFLICT DO NOTHING`;
    })().catch((error) => {
      promise = null;
      throw error;
    });
  return promise;
}
