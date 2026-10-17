import { createHash } from "node:crypto";
import { getDatabaseDriver } from "@/lib/config";
import { getSql, withTransaction, type SqlClient } from "@/lib/db";

/**
 * Idempotent constraint bootstrap for runtime schema code.
 *
 * Dropping and re-adding a constraint on every cold start takes an ACCESS
 * EXCLUSIVE lock and rescans hot tables, and concurrent cold starts race each
 * other into errors. Instead, each managed constraint carries a comment with a
 * hash of its intended definition. The constraint is only replaced when that
 * hash differs, under a per-table advisory lock, and is added NOT VALID (new
 * writes are enforced immediately) before a separate best-effort VALIDATE.
 *
 * Table, constraint, and definition arguments must be code constants: DDL
 * identifiers cannot be bound as query parameters.
 */

function rawQuery(sql: SqlClient, text: string) {
  return sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray);
}

function definitionSignature(definition: string) {
  return `corner-ops:${createHash("sha256").update(definition.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32)}`;
}

async function constraintComment(sql: SqlClient, table: string, name: string) {
  const rows = await sql`
    SELECT COALESCE(obj_description(c.oid, 'pg_constraint'), '') AS comment
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass(${table}::text) AND c.conname = ${name}
  `;
  return rows[0] ? String(rows[0].comment) : null;
}

async function underSchemaLock<T>(table: string, operation: (sql: SqlClient) => Promise<T>): Promise<T> {
  const run = async () => {
    const sql = getSql();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`corner-ops-schema:${table}`}))`;
    return operation(sql);
  };
  return getDatabaseDriver() === "postgres" ? withTransaction(run) : run();
}

export async function ensureTableConstraint(table: string, name: string, definition: string) {
  const signature = definitionSignature(definition);
  if ((await constraintComment(getSql(), table, name)) === signature) return;
  const changed = await underSchemaLock(table, async (sql) => {
    if ((await constraintComment(sql, table, name)) === signature) return false;
    await rawQuery(sql, `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
    await rawQuery(sql, `ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition} NOT VALID`);
    await rawQuery(sql, `COMMENT ON CONSTRAINT ${name} ON ${table} IS '${signature}'`);
    return true;
  });
  if (!changed) return;
  // Validation only takes SHARE UPDATE EXCLUSIVE. A legacy row that violates
  // the rule must not take the app down; the NOT VALID constraint still guards
  // every new write.
  const validate = async () => {
    const sql = getSql();
    if (getDatabaseDriver() !== "postgres") {
      await rawQuery(sql, `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
      return;
    }
    await rawQuery(sql, "SAVEPOINT corner_ops_validate_constraint");
    try {
      await rawQuery(sql, `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
      await rawQuery(sql, "RELEASE SAVEPOINT corner_ops_validate_constraint");
    } catch (error) {
      await rawQuery(sql, "ROLLBACK TO SAVEPOINT corner_ops_validate_constraint");
      throw error;
    }
  };
  await (getDatabaseDriver() === "postgres" ? withTransaction(validate) : validate()).catch((error) => {
    console.warn(`Constraint ${name} on ${table} is enforced for new rows but existing rows did not validate.`, error);
  });
}

export async function dropTableConstraintIfPresent(table: string, name: string) {
  if ((await constraintComment(getSql(), table, name)) === null) return;
  await underSchemaLock(table, async (sql) => {
    if ((await constraintComment(sql, table, name)) === null) return;
    await rawQuery(sql, `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
  });
}
