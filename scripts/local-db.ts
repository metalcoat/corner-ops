#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

loadEnvFile("/opt/corner-ops/.env");

function configureLocalDatabase(): void {
  if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD) {
    throw new Error("Local database commands require LOCAL_DEVELOPMENT=true and local PostgreSQL configuration.");
  }
  const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
  if (!/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Corner Ops PostgreSQL did not resolve to a private Docker address.");
  process.env.DATABASE_DRIVER = "postgres";
  process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
}

configureLocalDatabase();

async function main(): Promise<void> {
const { getDatabaseDriver } = await import("../src/lib/config");
const { ensureSchema, getSql, withTransaction } = await import("../src/lib/db");
const { ensureOrderingMenuImportSchema } = await import("../src/lib/ordering-menu-import-schema");
const { ensureOrderingPosSchema } = await import("../src/lib/ordering-pos-schema");

function assertLocalPostgres(): void {
  if (getDatabaseDriver() !== "postgres" || process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true") {
    throw new Error("Local database commands require DATABASE_DRIVER=postgres and LOCAL_DEVELOPMENT=true.");
  }
}

assertLocalPostgres();
const command = process.argv[2] || "status";
if (command === "bootstrap") {
  await ensureSchema();
  await ensureOrderingPosSchema();
  await ensureOrderingMenuImportSchema();
} else if (command === "verify-rollback") {
  await ensureOrderingMenuImportSchema();
  const marker = randomUUID();
  try {
    await withTransaction(async () => {
      await getSql()`
        INSERT INTO ordering_menu_import_runs (id, business, source, status, snapshot, created_by)
        VALUES (${marker}, 'Corner Deli', 'manual', 'preview', '{}'::jsonb, 'transaction-rollback-test')
      `;
      throw new Error("intentional rollback verification");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "intentional rollback verification") throw error;
  }
  const rows = await getSql()`SELECT id FROM ordering_menu_import_runs WHERE id = ${marker}`;
  if (rows.length) throw new Error("Transaction rollback verification failed.");
  console.log(JSON.stringify({ driver: getDatabaseDriver(), environment: "local-development", rollbackVerified: true }, null, 2));
  return;
} else if (command !== "status") {
  throw new Error("Usage: npm run db:bootstrap:local | npm run db:status");
}

const status = await getSql()`
  SELECT current_database() AS database,
         current_user AS database_user,
         version() AS postgres_version,
         to_regclass('public.ordering_menu_items') IS NOT NULL AS menu_schema,
         to_regclass('public.ordering_menu_import_runs') IS NOT NULL AS import_schema
`;
console.log(JSON.stringify({ driver: getDatabaseDriver(), environment: "local-development", ...status[0] }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
