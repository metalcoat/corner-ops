import { getSql } from "@/lib/db";
import { ensureOrderingSchema } from "@/lib/ordering-db";

let channelSchemaPromise: Promise<void> | null = null;

/**
 * Ordering extensions for restaurant-specific modifiers/combos, online-order
 * verification, and curbside arrival. Kept separate while the POS foundation
 * is developed so it can be reviewed before any production cutover.
 */
export function ensureOrderingChannelSchema(): Promise<void> {
  if (!channelSchemaPromise) {
    channelSchemaPromise = (async () => {
      await ensureOrderingSchema();
      const sql = getSql();

      // Expand fulfillment modes without depending on the original generated
      // CHECK definition. Existing values continue to remain valid.
      await sql`
        ALTER TABLE ordering_orders
        DROP CONSTRAINT IF EXISTS ordering_orders_service_type_check
      `;
      await sql`
        ALTER TABLE ordering_orders
        ADD CONSTRAINT ordering_orders_service_type_check
        CHECK (service_type IN (
          'pickup',
          'delivery',
          'no_contact_delivery',
          'dine_in',
          'curbside',
          'bar'
        ))
      `;

      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS sms_verified_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrival_status TEXT NOT NULL DEFAULT 'not_expected'`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrival_acknowledged_at TIMESTAMPTZ`;
      await sql`ALTER TABLE ordering_orders ADD COLUMN IF NOT EXISTS arrival_details TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_orders DROP CONSTRAINT IF EXISTS ordering_orders_arrival_status_check`;
      await sql`
        ALTER TABLE ordering_orders
        ADD CONSTRAINT ordering_orders_arrival_status_check
        CHECK (arrival_status IN ('not_expected', 'waiting', 'arrived', 'acknowledged', 'completed'))
      `;

      // Item-level modifier behavior supports defaults on subs and explicit
      // removal/extra treatment on kitchen tickets.
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_item_modifier_defaults (
          id UUID PRIMARY KEY,
          item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
          option_id UUID NOT NULL REFERENCES ordering_modifier_options(id) ON DELETE CASCADE,
          default_selected BOOLEAN NOT NULL DEFAULT FALSE,
          included_quantity INTEGER NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
          price_delta_override_cents INTEGER,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (item_id, option_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_item_modifier_defaults_idx ON ordering_menu_item_modifier_defaults (item_id, active)`;

      await sql`ALTER TABLE ordering_order_item_modifiers ADD COLUMN IF NOT EXISTS selection_state TEXT NOT NULL DEFAULT 'selected'`;
      await sql`ALTER TABLE ordering_order_item_modifiers DROP CONSTRAINT IF EXISTS ordering_order_item_modifiers_selection_state_check`;
      await sql`
        ALTER TABLE ordering_order_item_modifiers
        ADD CONSTRAINT ordering_order_item_modifiers_selection_state_check
        CHECK (selection_state IN ('selected', 'removed', 'extra'))
      `;

      // Combos are structured component groups rather than loose modifiers.
      // A sub can offer a combo with required Side and Drink groups, each with
      // its own available choices and optional upcharges.
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_combo_definitions (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          base_price_delta_cents INTEGER NOT NULL DEFAULT 0 CHECK (base_price_delta_cents >= 0),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_menu_item_combos (
          id UUID PRIMARY KEY,
          item_id UUID NOT NULL REFERENCES ordering_menu_items(id) ON DELETE CASCADE,
          combo_id UUID NOT NULL REFERENCES ordering_combo_definitions(id) ON DELETE CASCADE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (item_id, combo_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_menu_item_combos_item_idx ON ordering_menu_item_combos (item_id, active, sort_order)`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_combo_groups (
          id UUID PRIMARY KEY,
          combo_id UUID NOT NULL REFERENCES ordering_combo_definitions(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          min_selections INTEGER NOT NULL DEFAULT 1 CHECK (min_selections >= 0),
          max_selections INTEGER NOT NULL DEFAULT 1 CHECK (max_selections >= 1),
          sort_order INTEGER NOT NULL DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (max_selections >= min_selections),
          UNIQUE (combo_id, name)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_combo_options (
          id UUID PRIMARY KEY,
          group_id UUID NOT NULL REFERENCES ordering_combo_groups(id) ON DELETE CASCADE,
          menu_item_id UUID REFERENCES ordering_menu_items(id),
          name TEXT NOT NULL,
          price_delta_cents INTEGER NOT NULL DEFAULT 0,
          available BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (group_id, name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_combo_options_group_idx ON ordering_combo_options (group_id, active, available, sort_order)`;

      await sql`ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS combo_name_snapshot TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE ordering_order_items ADD COLUMN IF NOT EXISTS combo_total_cents INTEGER NOT NULL DEFAULT 0`;

      await sql`
        CREATE TABLE IF NOT EXISTS ordering_order_item_combo_selections (
          id UUID PRIMARY KEY,
          order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
          combo_id UUID NOT NULL REFERENCES ordering_combo_definitions(id),
          group_id UUID NOT NULL REFERENCES ordering_combo_groups(id),
          option_id UUID NOT NULL REFERENCES ordering_combo_options(id),
          combo_name_snapshot TEXT NOT NULL,
          group_name_snapshot TEXT NOT NULL,
          option_name_snapshot TEXT NOT NULL,
          price_delta_cents INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (order_item_id, group_id, option_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_order_item_combo_idx ON ordering_order_item_combo_selections (order_item_id, group_id)`;

      // Unpaid web orders must prove control of the supplied phone number.
      // Only a hash of the one-time code is persisted.
      await sql`
        CREATE TABLE IF NOT EXISTS ordering_sms_verifications (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          purpose TEXT NOT NULL DEFAULT 'unpaid_web_order' CHECK (purpose IN ('unpaid_web_order')),
          code_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'invalidated')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
          resend_count INTEGER NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          verified_at TIMESTAMPTZ,
          invalidated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ordering_sms_verifications_order_idx ON ordering_sms_verifications (order_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS ordering_sms_verifications_phone_idx ON ordering_sms_verifications (phone, created_at DESC)`;
    })().catch((error) => {
      channelSchemaPromise = null;
      throw error;
    });
  }

  return channelSchemaPromise;
}
