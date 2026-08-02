import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { assertConfigured } from "@/lib/config";

let queryClient: NeonQueryFunction<false, false> | null = null;
let schemaPromise: Promise<void> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  assertConfigured("DATABASE_URL");
  if (!queryClient) queryClient = neon(process.env.DATABASE_URL!);
  return queryClient;
}

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS documents (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          document_date DATE NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('Active', 'Needs Review', 'Archived')),
          notes TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          blob_url TEXT NOT NULL UNIQUE,
          blob_pathname TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS documents_business_created_idx ON documents (business, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status)`;
      await sql`
        CREATE TABLE IF NOT EXISTS audit_events (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          document_id UUID,
          action TEXT NOT NULL CHECK (action IN ('uploaded', 'updated', 'archived', 'restored', 'deleted')),
          actor TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS audit_events_business_created_idx ON audit_events (business, created_at DESC)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}
