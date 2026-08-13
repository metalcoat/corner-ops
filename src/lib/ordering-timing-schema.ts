import { getSql } from "@/lib/db";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let timingSchemaPromise: Promise<void> | null = null;

/**
 * Shared restaurant hours, ASAP estimates, future-order rules, and kitchen
 * timing snapshots. These settings are deliberately channel-independent so
 * POS, web, and AI phone ordering quote the same availability and wait times.
 */
export function ensureOrderingTimingSchema(): Promise<void> {
  if (!timingSchemaPromise) {
    timingSchemaPromise = (async () => {
      await ensureOrderingPosSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_business_ordering_settings (
          business TEXT PRIMARY KEY CHECK (business IN ('Corner Deli', 'Tiki')),
          timezone TEXT NOT NULL DEFAULT 'America/New_York',
          after_hours_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          allow_future_orders_when_closed BOOLEAN NOT NULL DEFAULT TRUE,
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        INSERT INTO ordering_business_ordering_settings (business)
        VALUES ('Corner Deli'), ('Tiki')
        ON CONFLICT (business) DO NOTHING
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_business_hours (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
          opens_at TIME NOT NULL,
          closes_at TIME NOT NULL,
          accepts_orders BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (closes_at <> opens_at)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_business_hours_lookup_idx ON ordering_business_hours (business, weekday, active, sort_order)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_business_hour_exceptions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          business_date DATE NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('closed', 'custom_hours')),
          opens_at TIME,
          closes_at TIME,
          note TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (
            (status = 'closed' AND opens_at IS NULL AND closes_at IS NULL)
            OR (status = 'custom_hours' AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at)
          ),
          UNIQUE (business, business_date)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_operating_windows (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          service_type TEXT NOT NULL DEFAULT 'all' CHECK (service_type IN ('all', 'pickup', 'delivery', 'dine_in', 'online', 'phone')),
          weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
          opens_at TIME NOT NULL,
          closes_at TIME NOT NULL,
          ordering_opens_at TIME,
          ordering_cutoff_at TIME,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (closes_at <> opens_at),
          CHECK ((ordering_opens_at IS NULL) = (ordering_cutoff_at IS NULL)),
          CHECK (ordering_opens_at IS NULL OR ordering_opens_at <> ordering_cutoff_at)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_operating_windows_lookup_idx ON ordering_operating_windows (business, service_type, weekday, active, sort_order)`;
      await sql`
        INSERT INTO ordering_operating_windows (
          id, business, service_type, weekday, opens_at, closes_at, active, sort_order, updated_by, created_at, updated_at
        )
        SELECT id, business, 'all', weekday, opens_at, closes_at, active AND accepts_orders, sort_order, created_by, created_at, updated_at
        FROM ordering_business_hours legacy
        WHERE NOT EXISTS (
          SELECT 1 FROM ordering_operating_windows current
          WHERE current.business = legacy.business AND current.service_type = 'all'
        )
        ON CONFLICT (id) DO NOTHING
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_special_hours (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          business_date DATE NOT NULL,
          service_type TEXT NOT NULL DEFAULT 'all' CHECK (service_type IN ('all', 'pickup', 'delivery', 'dine_in', 'online', 'phone')),
          status TEXT NOT NULL CHECK (status IN ('closed', 'custom_hours')),
          opens_at TIME,
          closes_at TIME,
          ordering_opens_at TIME,
          ordering_cutoff_at TIME,
          label TEXT NOT NULL DEFAULT '',
          updated_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (
            (status = 'closed' AND opens_at IS NULL AND closes_at IS NULL)
            OR (status = 'custom_hours' AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at)
          ),
          CHECK ((ordering_opens_at IS NULL) = (ordering_cutoff_at IS NULL)),
          UNIQUE (business, business_date, service_type)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_emergency_closures (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          service_type TEXT NOT NULL DEFAULT 'all' CHECK (service_type IN ('all', 'pickup', 'delivery', 'dine_in', 'online', 'phone')),
          starts_at TIMESTAMPTZ NOT NULL,
          ends_at TIMESTAMPTZ,
          reason TEXT NOT NULL,
          internal_note TEXT NOT NULL DEFAULT '',
          customer_message TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reopened_by TEXT,
          reopened_at TIMESTAMPTZ,
          CHECK (ends_at IS NULL OR ends_at > starts_at)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_emergency_closures_lookup_idx ON ordering_emergency_closures (business, service_type, starts_at DESC) WHERE reopened_at IS NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_operations_audit (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          actor_id TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_fulfillment_timing_settings (
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          service_type TEXT NOT NULL CHECK (service_type IN ('pickup', 'delivery', 'no_contact_delivery', 'dine_in', 'curbside', 'bar')),
          allow_asap BOOLEAN NOT NULL DEFAULT TRUE,
          allow_future BOOLEAN NOT NULL DEFAULT TRUE,
          normal_min_minutes INTEGER NOT NULL DEFAULT 30 CHECK (normal_min_minutes >= 0),
          normal_max_minutes INTEGER NOT NULL DEFAULT 30 CHECK (normal_max_minutes >= normal_min_minutes),
          busy_min_minutes INTEGER NOT NULL DEFAULT 60 CHECK (busy_min_minutes >= 0),
          busy_max_minutes INTEGER NOT NULL DEFAULT 60 CHECK (busy_max_minutes >= busy_min_minutes),
          busy_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK (busy_window_minutes > 0),
          busy_order_threshold INTEGER CHECK (busy_order_threshold IS NULL OR busy_order_threshold >= 0),
          max_future_days INTEGER NOT NULL DEFAULT 30 CHECK (max_future_days >= 0),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business, service_type)
        )
      `;

      // Stated Corner Deli guest-facing timing. Busy threshold remains NULL
      // until the owner chooses how many orders in what rolling period should
      // trigger the one-hour quote.
      await sql`
        INSERT INTO ordering_fulfillment_timing_settings (
          business, service_type, normal_min_minutes, normal_max_minutes,
          busy_min_minutes, busy_max_minutes, busy_window_minutes
        ) VALUES
          ('Corner Deli', 'pickup', 30, 30, 60, 60, 15),
          ('Corner Deli', 'curbside', 30, 30, 60, 60, 15),
          ('Corner Deli', 'delivery', 40, 45, 60, 60, 15),
          ('Corner Deli', 'no_contact_delivery', 40, 45, 60, 60, 15)
        ON CONFLICT (business, service_type) DO NOTHING
      `;

      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS timing_mode TEXT NOT NULL DEFAULT 'asap'`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS quoted_lead_min_minutes INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS quoted_lead_max_minutes INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS timing_message_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS kitchen_timing_label_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS kitchen_release_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_timing_mode_check`;
      await sql`ALTER TABLE ordering_orders ADD CONSTRAINT ordering_orders_timing_mode_check CHECK (timing_mode IN ('asap', 'future'))`;
      await sql`ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_quoted_lead_check`;
      await sql`
        ALTER TABLE ordering_orders
        ADD CONSTRAINT ordering_orders_quoted_lead_check
        CHECK (
          quoted_lead_min_minutes >= 0
          AND quoted_lead_max_minutes >= quoted_lead_min_minutes
        )
      `;

      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS store_was_open BOOLEAN`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS next_open_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_call_sessions ADD COLUMN IF NOT EXISTS after_hours_order_offered BOOLEAN NOT NULL DEFAULT FALSE`;
    })().catch((error) => {
      timingSchemaPromise = null;
      throw error;
    });
  }

  return timingSchemaPromise;
}
