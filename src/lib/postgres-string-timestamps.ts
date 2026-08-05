import { types } from "@neondatabase/serverless";

let installed = false;

/**
 * Keep PostgreSQL timestamp values consistent with the string-based row types
 * used throughout Corner Ops. Neon otherwise parses timestamp columns into
 * JavaScript Date objects, which breaks deterministic string comparisons.
 */
export function ensurePostgresStringTimestamps(): void {
  if (installed) return;

  // PostgreSQL OIDs: timestamp without time zone = 1114, timestamptz = 1184.
  types.setTypeParser(1114, (value) => value);
  types.setTypeParser(1184, (value) => value);
  installed = true;
}
