import { createHash } from "node:crypto";

// The 0001-0009 files are the historical baseline. Managed releases start at 0010.
export const FIRST_MANAGED_MIGRATION = "0010_";
export const migrationChecksum = (sql) => createHash("sha256").update(sql).digest("hex");

export async function applyMigrations(client, migrations) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SET LOCAL statement_timeout = '300s'");
    // One connection AND one transaction; HTTP calls cannot hold a session lock.
    await client.query("SELECT pg_advisory_xact_lock(1129270867, 1296648018)");
    await client.query(`CREATE TABLE IF NOT EXISTS public.corner_ops_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = [];
    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const existing = await client.query("SELECT checksum FROM public.corner_ops_schema_migrations WHERE name = $1", [migration.name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${migration.name}. Add a new migration instead.`);
        continue;
      }
      // Sequential query execution avoids preparing statements before their DDL exists.
      await client.query(migration.sql);
      await client.query("INSERT INTO public.corner_ops_schema_migrations (name, checksum) VALUES ($1, $2)", [migration.name, checksum]);
      applied.push(migration.name);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
