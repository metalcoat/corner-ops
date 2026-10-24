import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { RateLimitError } from "@/lib/http";

export type RateLimitPolicy = {
  scope: string;
  discriminator: string;
  maxFailures: number;
  windowSeconds: number;
  blockSeconds: number;
};

type LimitRow = {
  attempts: number | string;
  window_started_at: string | Date;
  blocked_until: string | Date | null;
};

let schemaPromise: Promise<void> | null = null;

async function ensureRateLimitSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Behind the Cloudflare tunnel cf-connecting-ip is set by Cloudflare and can't
 * be forged; the first X-Forwarded-For entry is whatever the client sent.
 */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

export function authRatePolicies(scope: string, request: Request, business: string): RateLimitPolicy[] {
  const ip = clientIp(request);
  return [
    {
      scope,
      discriminator: `ip-business:${ip}:${business}`,
      maxFailures: 8,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60,
    },
    {
      scope,
      discriminator: `business:${business}`,
      maxFailures: 50,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60,
    },
  ];
}

function secondsUntil(value: string | Date | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)) : 0;
}

export async function assertRateLimit(policies: RateLimitPolicy[]): Promise<void> {
  await ensureRateLimitSchema();
  const sql = getSql();
  for (const policy of policies) {
    const rows = await sql`
      SELECT attempts, window_started_at, blocked_until
      FROM security_rate_limits
      WHERE scope = ${policy.scope} AND discriminator_hash = ${key(policy.discriminator)}
      LIMIT 1
    ` as unknown as LimitRow[];
    const row = rows[0];
    if (!row) continue;
    const retryAfter = secondsUntil(row.blocked_until);
    if (retryAfter > 0) {
      throw new RateLimitError("Too many attempts. Try again later.", retryAfter);
    }
  }
}

export async function recordRateLimitFailure(policies: RateLimitPolicy[]): Promise<void> {
  await ensureRateLimitSchema();
  const sql = getSql();
  for (const policy of policies) {
    const discriminatorHash = key(policy.discriminator);
    await sql`
      INSERT INTO security_rate_limits (
        scope, discriminator_hash, attempts, window_started_at, blocked_until, updated_at
      ) VALUES (
        ${policy.scope}, ${discriminatorHash}, 1, NOW(), NULL, NOW()
      )
      ON CONFLICT (scope, discriminator_hash) DO UPDATE SET
        attempts = CASE
          WHEN security_rate_limits.window_started_at < NOW() - (${policy.windowSeconds} * INTERVAL '1 second') THEN 1
          ELSE security_rate_limits.attempts + 1
        END,
        window_started_at = CASE
          WHEN security_rate_limits.window_started_at < NOW() - (${policy.windowSeconds} * INTERVAL '1 second') THEN NOW()
          ELSE security_rate_limits.window_started_at
        END,
        blocked_until = CASE
          WHEN (
            CASE
              WHEN security_rate_limits.window_started_at < NOW() - (${policy.windowSeconds} * INTERVAL '1 second') THEN 1
              ELSE security_rate_limits.attempts + 1
            END
          ) >= ${policy.maxFailures}
          THEN NOW() + (${policy.blockSeconds} * INTERVAL '1 second')
          ELSE security_rate_limits.blocked_until
        END,
        updated_at = NOW()
    `;
  }
}

export async function clearRateLimit(policies: RateLimitPolicy[]): Promise<void> {
  await ensureRateLimitSchema();
  const sql = getSql();
  for (const policy of policies) {
    // One person signing in must not reset the business-wide counter that
    // limits guessing across many addresses.
    if (policy.discriminator.startsWith("business:")) continue;
    await sql`
      DELETE FROM security_rate_limits
      WHERE scope = ${policy.scope} AND discriminator_hash = ${key(policy.discriminator)}
    `;
  }
}

/**
 * Counts this request against every policy (not only failures), refusing once any
 * is over its limit. Each count is one atomic upsert (the row lock serializes
 * concurrent requests), so a burst can't slip past between a read and a write.
 */
export async function consumeRateLimit(policies: RateLimitPolicy[]): Promise<void> {
  await ensureRateLimitSchema();
  const sql = getSql();
  for (const policy of policies) {
    const window = policy.windowSeconds, block = policy.blockSeconds;
    const rows = await sql`
      INSERT INTO security_rate_limits (scope, discriminator_hash, attempts, window_started_at, blocked_until, updated_at)
      VALUES (${policy.scope}, ${key(policy.discriminator)}, 1, NOW(), NULL, NOW())
      ON CONFLICT (scope, discriminator_hash) DO UPDATE SET
        attempts = CASE WHEN security_rate_limits.window_started_at < NOW() - (${window} * INTERVAL '1 second') THEN 1 ELSE security_rate_limits.attempts + 1 END,
        window_started_at = CASE WHEN security_rate_limits.window_started_at < NOW() - (${window} * INTERVAL '1 second') THEN NOW() ELSE security_rate_limits.window_started_at END,
        blocked_until = CASE
          WHEN (CASE WHEN security_rate_limits.window_started_at < NOW() - (${window} * INTERVAL '1 second') THEN 1 ELSE security_rate_limits.attempts + 1 END) > ${policy.maxFailures}
          THEN GREATEST(COALESCE(security_rate_limits.blocked_until, NOW()), NOW() + (${block} * INTERVAL '1 second'))
          ELSE security_rate_limits.blocked_until END,
        updated_at = NOW()
      RETURNING attempts, blocked_until
    ` as unknown as LimitRow[];
    const retryAfter = secondsUntil(rows[0]?.blocked_until ?? null);
    if (retryAfter > 0) throw new RateLimitError("Too many attempts. Try again later.", retryAfter);
  }
}
