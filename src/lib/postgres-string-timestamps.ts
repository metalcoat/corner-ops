import { types } from "@neondatabase/serverless";
import { types as postgresTypes } from "pg";

let installed = false;

/**
 * Return PostgreSQL timestamp values as the raw text PostgreSQL sends
 * (e.g. "2026-10-05 12:34:56.123456+00"), matching production's database
 * layer. Installed once, process-wide, from src/lib/db.ts. Only
 * timestamp (OID 1114) and timestamptz (OID 1184) are changed; DATE (1082)
 * keeps the driver default.
 */
export function ensurePostgresStringTimestamps(): void {
  if (installed) return;

  types.setTypeParser(1114, (value) => value);
  types.setTypeParser(1184, (value) => value);
  postgresTypes.setTypeParser(1114, (value) => value);
  postgresTypes.setTypeParser(1184, (value) => value);
  installed = true;
}
