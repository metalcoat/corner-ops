#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { loadEnvFile } from "node:process";
import { NextRequest } from "next/server";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync(
  "docker",
  [
    "inspect",
    "corner-ops-postgres",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ],
  { encoding: "utf8" },
).trim();
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD || "")}@${address}:5432/cornerops`;

async function main() {
  const { getDeliveryPricingSettings, quoteDelivery } = await import(
    "../src/lib/ordering-delivery"
  );
  const settings = await getDeliveryPricingSettings("Corner Deli");
  assert(settings.enabled);
  assert(settings.feeBands.length > 0);
  const band = settings.feeBands[0];
  const distance =
    band.minMilesExclusive === 0
      ? Math.min(0.5, band.maxMilesInclusive)
      : (band.minMilesExclusive + band.maxMilesInclusive) / 2;
  const shortSubtotal = Math.max(0, settings.minimumOrderCents - 200);
  const short = await quoteDelivery({
    business: "Corner Deli",
    distanceMiles: distance,
    merchandiseSubtotalCents: shortSubtotal,
  });
  assert.equal(short.deliveryFeeCents, band.feeCents);
  assert.equal(
    short.minimum.shortfallCents,
    settings.minimumOrderCents - shortSubtotal,
  );
  const sufficient = await quoteDelivery({
    business: "Corner Deli",
    distanceMiles: distance,
    merchandiseSubtotalCents: settings.minimumOrderCents,
  });
  assert.equal(sufficient.minimum.shortfallCents, 0);
  assert.equal(
    sufficient.minimum.merchandiseSubtotalCents + sufficient.deliveryFeeCents,
    settings.minimumOrderCents + band.feeCents,
  );
  if (!process.env.SESSION_SECRET)
    throw new Error("SESSION_SECRET is required.");
  const encoded = Buffer.from(
      JSON.stringify({
        employeeId: "delivery-quote-validation",
        business: "Corner Deli",
        expiresAt: Date.now() + 60_000,
        clockInRequired: false,
      }),
    ).toString("base64url"),
    signature = createHmac("sha256", process.env.SESSION_SECRET)
      .update(encoded)
      .digest("base64url");
  const { proxy } = await import("../src/proxy");
  const authorized = proxy(
      new NextRequest("http://localhost/api/ordering/delivery/quote", {
        method: "POST",
        headers: {
          host: "localhost",
          cookie: `corner_ops_pos=${encoded}.${signature}`,
        },
      }),
    ),
    unauthorized = proxy(
      new NextRequest("http://localhost/api/ordering/delivery/quote", {
        method: "POST",
        headers: { host: "localhost" },
      }),
    );
  assert.equal(authorized.headers.get("x-middleware-next"), "1");
  assert.equal(unauthorized.status, 401);
  console.log("Delivery pricing validation passed.");
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
