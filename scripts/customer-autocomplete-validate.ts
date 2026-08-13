#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD || "")}@${address}:5432/cornerops`;

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { findCustomers } = await import("../src/lib/ordering-customers");
  const sql = getSql();
  const activeId = randomUUID(), mergedId = randomUUID();
  try {
  await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name,active) VALUES(${activeId},'Corner Deli','Autocomplete Sarah','Autocomplete','Sarah',TRUE),(${mergedId},'Corner Deli','Merged Sarah','Merged','Sarah',FALSE)`;
  await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,is_primary) VALUES(${randomUUID()},${activeId},'+13153233125','(315) 323-3125',TRUE),(${randomUUID()},${mergedId},'+13153239999','(315) 323-9999',TRUE)`;
  const phoneMatches = await findCustomers("Corner Deli", "31532");
  assert(phoneMatches.some((customer) => customer.id === activeId));
  assert(!phoneMatches.some((customer) => customer.id === mergedId));
  const nameMatches = await findCustomers("Corner Deli", "Autocomplete Sar");
  assert(nameMatches.some((customer) => customer.id === activeId));
  console.log("Customer autocomplete validation passed.");
  } finally {
    await sql`DELETE FROM ordering_customers WHERE id IN (${activeId},${mergedId})`;
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
