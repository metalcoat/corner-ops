#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD || "")}@${address}:5432/cornerops`;

async function main() {
  const { getDeliveryPricingSettings, quoteDelivery } = await import("../src/lib/ordering-delivery");
  const settings = await getDeliveryPricingSettings("Corner Deli");
  assert(settings.enabled);
  assert(settings.feeBands.length > 0);
  const band = settings.feeBands[0];
  const distance = band.minMilesExclusive === 0 ? Math.min(0.5, band.maxMilesInclusive) : (band.minMilesExclusive + band.maxMilesInclusive) / 2;
  const shortSubtotal = Math.max(0, settings.minimumOrderCents - 200);
  const short = await quoteDelivery({ business: "Corner Deli", distanceMiles: distance, merchandiseSubtotalCents: shortSubtotal });
  assert.equal(short.deliveryFeeCents, band.feeCents);
  assert.equal(short.minimum.shortfallCents, settings.minimumOrderCents - shortSubtotal);
  const sufficient = await quoteDelivery({ business: "Corner Deli", distanceMiles: distance, merchandiseSubtotalCents: settings.minimumOrderCents });
  assert.equal(sufficient.minimum.shortfallCents, 0);
  assert.equal(sufficient.minimum.merchandiseSubtotalCents + sufficient.deliveryFeeCents, settings.minimumOrderCents + band.feeCents);
  console.log("Delivery pricing validation passed.");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
