import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { assertConfigured } from "@/lib/config";
import { ensurePostgresStringTimestamps } from "@/lib/postgres-string-timestamps";

let queryClient: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  assertConfigured("DATABASE_URL");
  if (!queryClient) {
    ensurePostgresStringTimestamps();
    queryClient = neon(process.env.DATABASE_URL!);
  }
  return queryClient;
}

export async function ensureSchema(): Promise<void> {
  // Schema is owned by db/migrations. Runtime requests must never mutate it.
}
