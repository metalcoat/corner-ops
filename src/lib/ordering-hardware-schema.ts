import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let hardwareSchemaPromise: Promise<void> | null = null;

export function ensureOrderingHardwareSchema(): Promise<void> {
  if (!hardwareSchemaPromise) hardwareSchemaPromise = (async () => {
    await ensureOrderingPosSchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_hardware_locations (
      id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      name TEXT NOT NULL, location_key TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(business,location_key), UNIQUE(business,name)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_hardware_devices (
      id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      location_id UUID NOT NULL REFERENCES ordering_hardware_locations(id), name TEXT NOT NULL,
      device_key TEXT NOT NULL, device_type TEXT NOT NULL CHECK(device_type IN ('printer','payment_terminal','barcode_scanner')),
      role TEXT NOT NULL CHECK(role IN ('receipt_printer','kitchen_printer','payment_terminal','barcode_scanner')),
      station_key TEXT NOT NULL DEFAULT '', adapter_key TEXT NOT NULL DEFAULT 'unconfigured',
      adapter_config JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE,
      reported_status TEXT NOT NULL DEFAULT 'unknown' CHECK(reported_status IN ('online','offline','unknown')),
      last_seen_at TIMESTAMPTZ, status_message TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(business,device_key), UNIQUE(location_id,name)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_hardware_devices_scope_idx ON ordering_hardware_devices(business,location_id,device_type,active)`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_payment_stations (
      id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      name TEXT NOT NULL, station_key TEXT NOT NULL, station_mode TEXT NOT NULL DEFAULT 'order_taker' CHECK(station_mode IN ('payment','order_taker')),
      receipt_printer_id UUID REFERENCES ordering_hardware_devices(id), payment_terminal_id UUID REFERENCES ordering_hardware_devices(id),
      gift_card_reader_id UUID REFERENCES ordering_hardware_devices(id), active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(business,station_key), UNIQUE(business,name)
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_one_payment_station_idx ON ordering_payment_stations(business) WHERE station_mode='payment' AND active=TRUE`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_payment_station_queue (
      id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')), order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
      check_id UUID REFERENCES ordering_checks(id) ON DELETE CASCADE, source_station_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','completed','cancelled')),
      requested_by TEXT NOT NULL, claimed_by TEXT NOT NULL DEFAULT '', request_note TEXT NOT NULL DEFAULT '',
      queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_payment_station_queue_active_idx ON ordering_payment_station_queue(business,order_id,COALESCE(check_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('queued','claimed')`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_payment_station_queue_status_idx ON ordering_payment_station_queue(business,status,queued_at)`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_printer_routes (
      id UUID PRIMARY KEY, business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      location_id UUID NOT NULL REFERENCES ordering_hardware_locations(id), printer_id UUID NOT NULL REFERENCES ordering_hardware_devices(id),
      target_type TEXT NOT NULL CHECK(target_type IN ('all','item','category','station')),
      target_id TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(business,location_id,target_type,target_id,printer_id)
    )`;
    await sql`ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES ordering_hardware_locations(id)`;
    await sql`ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES ordering_hardware_devices(id)`;
    await sql`ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT`;
    await sql`ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES ordering_print_jobs(id)`;
    await sql`ALTER TABLE ordering_print_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ordering_print_jobs_idempotency_idx ON ordering_print_jobs(business,idempotency_key) WHERE idempotency_key IS NOT NULL`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_print_jobs_queue_idx ON ordering_print_jobs(business,status,queued_at DESC)`;
  })().catch(error => { hardwareSchemaPromise = null; throw error; });
  return hardwareSchemaPromise;
}
