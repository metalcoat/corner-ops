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

/**
 * One pool per process. An idle client that loses its connection (Postgres
 * restart, network blip) emits "error" on the pool; without a listener Node
 * treats it as unhandled and the whole app exits. A request waiting for a
 * free client gives up after 10 s instead of hanging, and a transaction left
 * open and idle (a bug, or a request that died mid-way) is closed by Postgres
 * after 5 minutes so its row locks don't stall every register.
 */
function createPostgresPool(): Pool {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 300_000,
  });
  pool.on("error", (error) => console.error("[db] idle PostgreSQL client error", error));
  return pool;
}

function getPostgresClient(): SqlClient {
  if (!postgresPool) {
    postgresPool = createPostgresPool();
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

/** True while running inside withTransaction (nested calls join the outer transaction). */
export function inTransaction(): boolean {
  return Boolean(transactionClient.getStore());
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
  if (!postgresPool) postgresPool = createPostgresPool();
  const client = await postgresPool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await transactionClient.run(taggedQuery((text, values) => client.query(text, values)), operation);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The connection is unusable; discard it rather than return it to the pool.
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(broken);
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
