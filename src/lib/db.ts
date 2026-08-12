import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import { assertConfigured, getDatabaseDriver } from "@/lib/config";

export type SqlRow = Record<string, any>;

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: any[]): Promise<SqlRow[]>;
}

let queryClient: SqlClient | null = null;
let postgresPool: Pool | null = null;
let schemaPromise: Promise<void> | null = null;

function getPostgresClient(): SqlClient {
  if (!postgresPool) {
    postgresPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ""),
      "",
    );
    const result = await postgresPool!.query(text, values);
    return result.rows;
  };

  return query;
}

function getNeonClient(): SqlClient {
  const client = neon(process.env.DATABASE_URL!);
  return async (strings, ...values) => client(strings, ...values);
}

export function getSql(): SqlClient {
  assertConfigured("DATABASE_URL");
  if (!queryClient) {
    queryClient = getDatabaseDriver() === "postgres"
      ? getPostgresClient()
      : getNeonClient();
  }
  return queryClient;
}

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS documents (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          document_date DATE NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Active', 'Needs Review', 'Archived')),
          notes TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          blob_url TEXT NOT NULL UNIQUE,
          blob_pathname TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS documents_business_created_idx ON documents (business, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status)`;

      await sql`
        CREATE TABLE IF NOT EXISTS audit_events (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          document_id UUID,
          action TEXT NOT NULL CHECK (action IN ('uploaded', 'updated', 'archived', 'restored', 'deleted')),
          actor TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS audit_events_business_created_idx ON audit_events (business, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS employees (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          name TEXT NOT NULL,
          pin_hash TEXT NOT NULL,
          position TEXT NOT NULL DEFAULT 'Bartender',
          role_group TEXT NOT NULL DEFAULT 'In-House' CHECK (role_group IN ('Driver', 'In-House', 'Ignore')),
          counts_for_tips BOOLEAN NOT NULL DEFAULT TRUE,
          hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
          tipped_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (business, pin_hash)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS employees_business_active_idx ON employees (business, active, name)`;

      await sql`
        CREATE TABLE IF NOT EXISTS time_entries (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          employee_id UUID NOT NULL REFERENCES employees(id),
          employee_name TEXT NOT NULL,
          position TEXT NOT NULL,
          role_group TEXT NOT NULL CHECK (role_group IN ('Driver', 'In-House', 'Ignore')),
          clock_in TIMESTAMPTZ NOT NULL,
          clock_out TIMESTAMPTZ,
          clock_in_lat NUMERIC(10,7),
          clock_in_lng NUMERIC(10,7),
          clock_in_accuracy NUMERIC(10,2),
          clock_out_lat NUMERIC(10,7),
          clock_out_lng NUMERIC(10,7),
          clock_out_accuracy NUMERIC(10,2),
          source TEXT NOT NULL DEFAULT 'Corner Ops',
          status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Complete', 'Needs Review', 'Corrected')),
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS time_entries_business_clock_idx ON time_entries (business, clock_in DESC)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS one_open_time_entry_per_employee ON time_entries (employee_id) WHERE clock_out IS NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS rezku_import_batches (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL DEFAULT 'Corner Deli' CHECK (business = 'Corner Deli'),
          report_type TEXT NOT NULL CHECK (report_type IN ('shifts', 'orders', 'transactions')),
          file_name TEXT NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          imported_by TEXT NOT NULL,
          imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_import_batches_created_idx ON rezku_import_batches (imported_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS rezku_shifts (
          id UUID PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          batch_id UUID NOT NULL REFERENCES rezku_import_batches(id) ON DELETE CASCADE,
          employee_name TEXT NOT NULL,
          position TEXT NOT NULL DEFAULT '',
          role_group TEXT NOT NULL DEFAULT 'In-House',
          clock_in TIMESTAMPTZ,
          clock_out TIMESTAMPTZ,
          reported_hours NUMERIC(10,4) NOT NULL DEFAULT 0,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_shifts_clock_idx ON rezku_shifts (clock_in, clock_out)`;

      await sql`
        CREATE TABLE IF NOT EXISTS rezku_orders (
          id UUID PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          batch_id UUID NOT NULL REFERENCES rezku_import_batches(id) ON DELETE CASCADE,
          order_id TEXT NOT NULL,
          opened_at TIMESTAMPTZ,
          order_type TEXT NOT NULL DEFAULT '',
          raw JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_orders_order_idx ON rezku_orders (order_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS rezku_transactions (
          id UUID PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          batch_id UUID NOT NULL REFERENCES rezku_import_batches(id) ON DELETE CASCADE,
          transaction_id TEXT NOT NULL DEFAULT '',
          order_id TEXT NOT NULL DEFAULT '',
          transaction_time TIMESTAMPTZ,
          tip NUMERIC(12,2) NOT NULL DEFAULT 0,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_transactions_time_idx ON rezku_transactions (transaction_time)`;

      await sql`
        CREATE TABLE IF NOT EXISTS accounting_accounts (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          account_type TEXT NOT NULL CHECK (account_type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          UNIQUE (business, code)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS journal_entries (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          entry_date DATE NOT NULL,
          description TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'Manual',
          reference TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS journal_entries_business_date_idx ON journal_entries (business, entry_date DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS journal_lines (
          id UUID PRIMARY KEY,
          entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
          account_id UUID NOT NULL REFERENCES accounting_accounts(id),
          debit NUMERIC(14,2) NOT NULL DEFAULT 0,
          credit NUMERIC(14,2) NOT NULL DEFAULT 0,
          CHECK (debit >= 0 AND credit >= 0),
          CHECK (NOT (debit > 0 AND credit > 0))
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines (entry_id)`;

      await sql`
        INSERT INTO accounting_accounts (id, business, code, name, account_type)
        VALUES
          (gen_random_uuid(), 'Corner Deli', '1000', 'Operating Cash', 'Asset'),
          (gen_random_uuid(), 'Corner Deli', '1100', 'Bank Clearing', 'Asset'),
          (gen_random_uuid(), 'Corner Deli', '2000', 'Accounts Payable', 'Liability'),
          (gen_random_uuid(), 'Corner Deli', '2100', 'Credit Cards', 'Liability'),
          (gen_random_uuid(), 'Corner Deli', '3000', 'Owner Equity', 'Equity'),
          (gen_random_uuid(), 'Corner Deli', '4000', 'Food and Beverage Sales', 'Revenue'),
          (gen_random_uuid(), 'Corner Deli', '5000', 'Cost of Goods Sold', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5100', 'Payroll', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5200', 'Rent and Occupancy', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5300', 'Utilities', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5400', 'Supplies', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5500', 'Repairs and Maintenance', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5600', 'Merchant and Bank Fees', 'Expense'),
          (gen_random_uuid(), 'Corner Deli', '5900', 'Other Expense', 'Expense'),
          (gen_random_uuid(), 'Tiki', '1000', 'Operating Cash', 'Asset'),
          (gen_random_uuid(), 'Tiki', '1100', 'Bank Clearing', 'Asset'),
          (gen_random_uuid(), 'Tiki', '2000', 'Accounts Payable', 'Liability'),
          (gen_random_uuid(), 'Tiki', '2100', 'Credit Cards', 'Liability'),
          (gen_random_uuid(), 'Tiki', '3000', 'Owner Equity', 'Equity'),
          (gen_random_uuid(), 'Tiki', '4100', 'Bar Sales', 'Revenue'),
          (gen_random_uuid(), 'Tiki', '5000', 'Cost of Goods Sold', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5100', 'Payroll', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5200', 'Rent and Occupancy', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5300', 'Utilities', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5400', 'Supplies', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5500', 'Repairs and Maintenance', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5600', 'Merchant and Bank Fees', 'Expense'),
          (gen_random_uuid(), 'Tiki', '5900', 'Other Expense', 'Expense')
        ON CONFLICT (business, code) DO NOTHING
      `;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}
