import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
let promise: Promise<void> | null = null;
export function ensureOrderingTipSchema() {
  if (!promise)
    promise = (async () => {
      await ensureOrderingPosSchema();
      const sql = getSql();
      await sql`CREATE TABLE IF NOT EXISTS ordering_tip_policies(business TEXT PRIMARY KEY CHECK(business IN('Corner Deli','Tiki')),delivery_policy TEXT NOT NULL DEFAULT 'assigned_driver' CHECK(delivery_policy IN('assigned_driver','order_taker','pool')),counter_policy TEXT NOT NULL DEFAULT 'order_taker' CHECK(counter_policy IN('order_taker','pool')),pool_clocked_in_only BOOLEAN NOT NULL DEFAULT TRUE,updated_by TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`INSERT INTO ordering_tip_policies(business)VALUES('Corner Deli') ON CONFLICT DO NOTHING`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_tip_allocations(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),order_id UUID NOT NULL REFERENCES ordering_orders(id),employee_id UUID REFERENCES employees(id),employee_name TEXT NOT NULL DEFAULT '',tender_type TEXT NOT NULL CHECK(tender_type IN('cash','card','gift_card','other')),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),status TEXT NOT NULL DEFAULT 'eligible' CHECK(status IN('unassigned','eligible','paid','reversed')),allocation_reason TEXT NOT NULL DEFAULT '',payout_batch_id UUID,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(order_id,employee_id,tender_type))`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_tip_allocations_status_idx ON ordering_tip_allocations(business,status,employee_id)`;
      await sql`CREATE TABLE IF NOT EXISTS ordering_tip_payout_batches(id UUID PRIMARY KEY,business TEXT NOT NULL CHECK(business IN('Corner Deli','Tiki')),status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN('posted','reversed')),total_cents INTEGER NOT NULL DEFAULT 0,employee_count INTEGER NOT NULL DEFAULT 0,period_start DATE,period_end DATE,created_by TEXT NOT NULL,approved_by TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reversed_at TIMESTAMPTZ)`;
      await sql`ALTER TABLE ordering_tip_allocations DROP CONSTRAINT IF EXISTS ordering_tip_allocations_payout_batch_id_fkey`;
      await sql`ALTER TABLE ordering_tip_allocations ADD CONSTRAINT ordering_tip_allocations_payout_batch_id_fkey FOREIGN KEY(payout_batch_id) REFERENCES ordering_tip_payout_batches(id)`;
    })().catch((error) => {
      promise = null;
      throw error;
    });
  return promise;
}
