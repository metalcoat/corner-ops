#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

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
  const { getSql } = await import("../src/lib/db");
  const { linkGoogleCustomer } =
    await import("../src/lib/customer-google-auth");
  const sql = getSql();
  const suffix = randomUUID();
  const existingEmail = `google-existing-${suffix}@example.test`;
  const newEmail = `google-new-${suffix}@example.test`;
  const existingId = randomUUID();
  try {
    await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name,email) VALUES(${existingId},'Corner Deli','Existing Google Customer','Existing','Customer',${existingEmail})`;
    await sql`INSERT INTO ordering_customer_emails(id,customer_id,normalized_email,display_email,is_primary) VALUES(${randomUUID()},${existingId},${existingEmail},${existingEmail},TRUE)`;

    const linkedId = await linkGoogleCustomer({
      sub: `existing-${suffix}`,
      email: existingEmail.toUpperCase(),
      email_verified: true,
      given_name: "Existing",
      family_name: "Customer",
    });
    assert.equal(linkedId, existingId);

    const createdId = await linkGoogleCustomer({
      sub: `new-${suffix}`,
      email: newEmail,
      email_verified: true,
      given_name: "New",
      family_name: "Customer",
    });
    assert.notEqual(createdId, existingId);
    const created = (
      await sql`SELECT id FROM ordering_customers WHERE id=${createdId} AND email=${newEmail}`
    )[0];
    assert.equal(String(created?.id), createdId);
    console.log("Google customer linking validation passed.");
  } finally {
    await sql`DELETE FROM ordering_customers WHERE business='Corner Deli' AND lower(email) IN (${existingEmail},${newEmail})`;
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
