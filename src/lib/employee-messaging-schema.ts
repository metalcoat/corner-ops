import { getSql, ensureSchema } from "@/lib/db";

let employeeMessagingSchemaPromise: Promise<void> | null = null;

/**
 * Login-time employee messages, targeting, and acknowledgement receipts.
 */
export function ensureEmployeeMessagingSchema(): Promise<void> {
  if (!employeeMessagingSchemaPromise) {
    employeeMessagingSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS employee_messages (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'reminder' CHECK (category IN (
            'reminder',
            'operational',
            'menu_change',
            'safety',
            'policy',
            'training',
            'urgent'
          )),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important', 'critical')),
          delivery_mode TEXT NOT NULL DEFAULT 'once' CHECK (delivery_mode IN (
            'once',
            'once_per_shift',
            'until_acknowledged',
            'every_login'
          )),
          requires_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
          task_confirmation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ends_at TIMESTAMPTZ,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (ends_at IS NULL OR ends_at > starts_at)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employee_messages_active_idx ON employee_messages (business, active, starts_at, ends_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS employee_message_targets (
          id UUID PRIMARY KEY,
          message_id UUID NOT NULL REFERENCES employee_messages(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK (target_type IN ('all', 'role_group', 'position', 'employee')),
          target_value TEXT NOT NULL DEFAULT '',
          employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (
            (target_type = 'employee' AND employee_id IS NOT NULL)
            OR
            (target_type <> 'employee' AND employee_id IS NULL)
          )
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employee_message_targets_message_idx ON employee_message_targets (message_id, target_type)`;
      await sql`CREATE INDEX IF NOT EXISTS employee_message_targets_employee_idx ON employee_message_targets (employee_id) WHERE employee_id IS NOT NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS employee_message_receipts (
          id UUID PRIMARY KEY,
          message_id UUID NOT NULL REFERENCES employee_messages(id) ON DELETE CASCADE,
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          time_entry_id UUID REFERENCES time_entries(id) ON DELETE SET NULL,
          first_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          shown_count INTEGER NOT NULL DEFAULT 1 CHECK (shown_count > 0),
          acknowledged_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          acknowledgement_method TEXT NOT NULL DEFAULT '',
          completion_details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (message_id, employee_id, time_entry_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employee_message_receipts_employee_idx ON employee_message_receipts (employee_id, last_shown_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS employee_message_receipts_message_idx ON employee_message_receipts (message_id, acknowledged_at, completed_at)`;
    })().catch((error) => {
      employeeMessagingSchemaPromise = null;
      throw error;
    });
  }

  return employeeMessagingSchemaPromise;
}
