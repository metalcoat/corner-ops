#!/usr/bin/env node
// A burst of parallel requests can't get past a rate limit (consumeRateLimit is one
// atomic upsert per policy). Uses a throwaway scope on the dev database and removes it.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main(): Promise<void> {
  const { getSql } = await import("../src/lib/db");
  const { consumeRateLimit } = await import("../src/lib/rate-limit");
  const scope = `burst-validation-${randomUUID()}`;
  const policy = { scope, discriminator: "ip:203.0.113.7", maxFailures: 5, windowSeconds: 60, blockSeconds: 60 };
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 30 }, () => consumeRateLimit([policy])));
    const allowed = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    if (allowed !== 5) throw new Error(`Expected exactly 5 of 30 parallel requests through, got ${allowed}.`);
    console.log(JSON.stringify({ parallelRequests: 30, allowed, limit: 5 }, null, 2));
  } finally {
    await getSql()`DELETE FROM security_rate_limits WHERE scope=${scope}`;
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
