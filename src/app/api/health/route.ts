import { getDatabaseDriver, getStorageDriver } from "@/lib/config";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  const checkDatabase = process.env.HEALTHCHECK_DATABASE?.trim().toLowerCase() === "true";

  if (!checkDatabase) {
    return Response.json({
      status: "ok",
      database: { status: "not_checked" },
      storage: { driver: safeStorageDriver() },
      responseTimeMs: Date.now() - startedAt,
    });
  }

  try {
    await getSql()`SELECT 1 AS healthy`;
    return Response.json({
      status: "ok",
      database: { status: "ok", driver: getDatabaseDriver() },
      storage: { driver: getStorageDriver() },
      responseTimeMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[api/health] database health check failed", error);
    return Response.json({
      status: "degraded",
      database: { status: "error", driver: safeDatabaseDriver() },
      storage: { driver: safeStorageDriver() },
      responseTimeMs: Date.now() - startedAt,
    }, { status: 503 });
  }
}

function safeDatabaseDriver(): string {
  try { return getDatabaseDriver(); } catch { return "invalid"; }
}

function safeStorageDriver(): string {
  try { return getStorageDriver(); } catch { return "invalid"; }
}
