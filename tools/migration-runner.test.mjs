import assert from "node:assert/strict";
import test from "node:test";
import { applyMigrations } from "./migration-runner.mjs";

function database() {
  let ledger = new Map(); let staged = null; const calls = [];
  return { calls, ledger: () => ledger, query: async (sql, args = []) => {
    calls.push(sql);
    if (sql === "BEGIN") staged = new Map(ledger);
    if (sql === "COMMIT") { ledger = staged; staged = null; }
    if (sql === "ROLLBACK") staged = null;
    if (sql === "BROKEN SQL") throw new Error("injected migration failure");
    if (sql.startsWith("SELECT checksum")) return { rows: staged.has(args[0]) ? [{ checksum: staged.get(args[0]) }] : [] };
    if (sql.startsWith("INSERT INTO public.corner_ops_schema_migrations")) staged.set(args[0], args[1]);
    return { rows: [] };
  } };
}
test("migration lock covers the ledger, DDL, and commit on one client", async () => {
  const db = database(); const migrations = [{ name: "0010_test.sql", sql: "SELECT 1" }];
  assert.deepEqual(await applyMigrations(db, migrations), ["0010_test.sql"]);
  assert.ok(db.calls.findIndex((s) => s.includes("pg_advisory_xact_lock")) < db.calls.findIndex((s) => s.startsWith("CREATE TABLE")));
  assert.equal(db.calls.at(-1), "COMMIT");
  assert.deepEqual(await applyMigrations(db, migrations), []);
});
test("failed migration rolls back both schema work and the migration ledger", async () => {
  const db = database();
  await assert.rejects(applyMigrations(db, [{ name: "0010_test.sql", sql: "SELECT 1" }, { name: "0011_bad.sql", sql: "BROKEN SQL" }]));
  assert.equal(db.calls.at(-1), "ROLLBACK"); assert.equal(db.ledger().size, 0);
});
test("editing an already applied migration fails instead of silently replaying it", async () => {
  const db = database(); await applyMigrations(db, [{ name: "0010_test.sql", sql: "SELECT 1" }]);
  await assert.rejects(applyMigrations(db, [{ name: "0010_test.sql", sql: "SELECT 2" }]), /Applied migration changed/);
});
