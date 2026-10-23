import { neon } from "@neondatabase/serverless";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { assertConfigured, getDatabaseDriver } from "@/lib/config";
import { ensurePostgresStringTimestamps } from "@/lib/postgres-string-timestamps";

// Match production: timestamp (1114) and timestamptz (1184) columns arrive as
// raw PostgreSQL text (e.g. "2026-10-05 12:34:56.123456+00"), never as Date
// objects. Installed once, before any pool or client exists. DATE (1082) keeps
// the pg default. Use toIsoTimestamp() from "@/lib/timestamp-values" when a
// browser (Safari) needs to parse the value.
ensurePostgresStringTimestamps();

export type SqlRow = Record<string, any>;

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: any[]): Promise<SqlRow[]>;
}

let queryClient: SqlClient | null = null;
let postgresPool: Pool | null = null;
let schemaPromise: Promise<void> | null = null;
const transactionClient = new AsyncLocalStorage<SqlClient>();

function taggedQuery(query: (text: string, values?: unknown[]) => Promise<{ rows: SqlRow[] }>): SqlClient {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ""),
      "",
    );
    return (await query(text, values)).rows;
  };
}

function getPostgresClient(): SqlClient {
  if (!postgresPool) {
    postgresPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  return taggedQuery((text, values) => postgresPool!.query(text, values));
}

function getNeonClient(): SqlClient {
  const client = neon(process.env.DATABASE_URL!);
  return async (strings, ...values) => client(strings, ...values);
}

export function getSql(): SqlClient {
  assertConfigured("DATABASE_URL");
  const activeTransaction = transactionClient.getStore();
  if (activeTransaction) return activeTransaction;
  if (!queryClient) {
    queryClient = getDatabaseDriver() === "postgres"
      ? getPostgresClient()
      : getNeonClient();
  }
  return queryClient;
}

/**
 * Runs queries on the shared connection even inside withTransaction, so a
 * record (like a processor refund that already happened) survives a rollback.
 */
export function outsideTransaction<T>(operation: () => T): T {
  return transactionClient.exit(operation);
}

export async function withTransaction<T>(operation: () => Promise<T>): Promise<T> {
  assertConfigured("DATABASE_URL");
  if (getDatabaseDriver() !== "postgres") {
    throw new Error("Interactive transactions are available only through the local PostgreSQL driver.");
  }
  if (transactionClient.getStore()) return operation();
  if (!postgresPool) postgresPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await postgresPool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactionClient.run(taggedQuery((text, values) => client.query(text, values)), operation);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = getSql();

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
