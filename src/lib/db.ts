import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { Pool, types } from "pg";
import { assertConfigured, getDatabaseDriver } from "@/lib/config";
import { ensurePostgresStringTimestamps } from "@/lib/postgres-string-timestamps";

type Query = { text: string; values: unknown[] };
type DeferredQuery = PromiseLike<Record<string, unknown>[]> & Query;

let queryClient: NeonQueryFunction<false, false> | null = null;
let postgresPool: Pool | null = null;

function getPostgresClient(): NeonQueryFunction<false, false> {
  types.setTypeParser(1114, (value) => value);
  types.setTypeParser(1184, (value) => value);
  postgresPool ||= new Pool({ connectionString: process.env.DATABASE_URL });
  const pool = postgresPool;

  const sql = (strings: TemplateStringsArray, ...values: unknown[]): DeferredQuery => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ""),
      "",
    );
    const run = () => pool.query(text, values).then((result) => result.rows);
    return { text, values, then: (resolve, reject) => run().then(resolve, reject) };
  };

  const client = sql as typeof sql & {
    transaction: (queries: DeferredQuery[]) => Promise<Record<string, unknown>[][]>;
  };
  client.transaction = async (queries) => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const results = [];
      for (const query of queries) {
        if (typeof query.text !== "string" || !Array.isArray(query.values)) {
          throw new Error("Invalid PostgreSQL transaction query.");
        }
        results.push((await connection.query(query.text, query.values)).rows);
      }
      await connection.query("COMMIT");
      return results;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  };
  return client as unknown as NeonQueryFunction<false, false>;
}

export function getSql(): NeonQueryFunction<false, false> {
  assertConfigured("DATABASE_URL");
  if (!queryClient) {
    queryClient = getDatabaseDriver() === "postgres"
      ? getPostgresClient()
      : (ensurePostgresStringTimestamps(), neon(process.env.DATABASE_URL!));
  }
  return queryClient;
}

export async function ensureSchema(): Promise<void> {
  // Schema is owned by db/migrations. Runtime requests must never mutate it.
}
