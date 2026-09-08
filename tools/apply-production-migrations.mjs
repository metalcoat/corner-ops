import { Client } from "@neondatabase/serverless";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyMigrations, FIRST_MANAGED_MIGRATION, migrationChecksum } from "./migration-runner.mjs";

const args = new Set(process.argv.slice(2));
if (!args.has("--apply") && !args.has("--check")) throw new Error("Use --check or --apply. Database migrations never run as part of a build.");
if (args.has("--apply") && args.has("--check")) throw new Error("Choose --apply or --check, not both.");
if (args.has("--apply") && process.env.VERCEL_ENV === "production" && !args.has("--production")) {
  throw new Error("A production migration requires the explicit --production flag.");
}
const connectionString = process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required.");
const directory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const names = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name >= FIRST_MANAGED_MIGRATION).sort();
const migrations = await Promise.all(names.map(async (name) => ({ name, sql: await readFile(`${directory}/${name}`, "utf8") })));
const client = new Client({ connectionString });
try {
  await client.connect();
  const baseline = await client.query("SELECT to_regclass('public.employees') AS employees, to_regclass('public.employee_messages') AS messages, to_regclass('public.bank_accounts') AS accounts");
  if (!baseline.rows[0]?.employees || !baseline.rows[0]?.messages || !baseline.rows[0]?.accounts) {
    throw new Error("Historical schema baseline is missing. Initialize the documented 0001-0009 baseline before applying managed releases.");
  }
  if (args.has("--check")) {
    const table = await client.query("SELECT to_regclass('public.corner_ops_schema_migrations') AS ledger");
    const rows = table.rows[0]?.ledger ? (await client.query("SELECT name, checksum FROM public.corner_ops_schema_migrations")).rows : [];
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    for (const migration of migrations) {
      const checksum = applied.get(migration.name);
      if (checksum && checksum !== migrationChecksum(migration.sql)) throw new Error(`Applied migration changed: ${migration.name}`);
      console.log(`${checksum ? "Applied" : "Pending"}: ${migration.name}`);
    }
  } else {
    const applied = await applyMigrations(client, migrations);
    console.log(`Committed ${applied.length} migration(s): ${applied.join(", ") || "none"}`);
  }
} catch (error) {
  // Do not print connection strings, SQL bindings, or provider error detail.
  console.error("Migration failed. No release should be promoted until migration status is verified.");
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]") : "Unknown migration error");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
