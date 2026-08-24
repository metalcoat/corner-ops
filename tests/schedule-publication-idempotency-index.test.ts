import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("schedule publication conflict target matches the partial idempotency index", () => {
  const source = readFileSync(join(root, "src/lib/business-schedule-publication.ts"), "utf8");
  const migrationsDir = join(root, "db/migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(join(migrationsDir, name), "utf8"))
    .join("\n");

  assert.match(
    migrations,
    /schedule_publications_idempotency_idx[\s\S]*idempotency_key[\s\S]*WHERE\s+\(?idempotency_key\s+IS\s+NOT\s+NULL\)?/i,
  );
  assert.match(
    source,
    /ON\s+CONFLICT\s*\(idempotency_key\)\s+WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL\s+DO\s+NOTHING/i,
  );
});
