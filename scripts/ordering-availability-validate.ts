import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { isWithinInclusiveWindow } from "../src/lib/ordering-availability";

const cutoff = 21 * 60 + 30;
assert.equal(isWithinInclusiveWindow(9 * 60, cutoff, 21 * 60 + 29), true);
assert.equal(isWithinInclusiveWindow(9 * 60, cutoff, 21 * 60 + 30), true);
assert.equal(isWithinInclusiveWindow(9 * 60, cutoff, 21 * 60 + 31), false);

assert.equal(isWithinInclusiveWindow(22 * 60, 2 * 60, 23 * 60), true);
assert.equal(isWithinInclusiveWindow(22 * 60, 2 * 60, 2 * 60), true);
assert.equal(isWithinInclusiveWindow(22 * 60, 2 * 60, 3 * 60), false);

async function integration() {
  loadEnvFile("/opt/corner-ops/.env");
  const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
  process.env.DATABASE_DRIVER = "postgres";
  process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD || "")}@${address}:5432/cornerops`;
  const { getSql } = await import("../src/lib/db");
  const { resolveOrderingAvailability } = await import("../src/lib/ordering-availability");
  const sql = getSql(), windowId = randomUUID(), closureId = randomUUID();
  try {
    await sql`INSERT INTO ordering_operating_windows(id,business,service_type,weekday,opens_at,closes_at,active,updated_by) VALUES(${windowId},'Corner Deli','pickup',4,'09:00','21:30',TRUE,'availability-test')`;
    const preOpen = await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-13T12:00:00Z"), allowPreOpenAsap: true });
    assert.equal(preOpen.orderable, true);
    assert.equal(preOpen.open, false);
    assert.equal((await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-14T01:29:59Z") })).orderable, true);
    assert.equal((await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-14T01:30:59Z") })).orderable, true);
    assert.equal((await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-14T01:31:00Z") })).orderable, false);
    assert.equal((await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-14T01:31:00Z"), orderEntryStartedAt: new Date("2026-08-14T01:30:30Z") })).orderable, true);
    await sql`INSERT INTO ordering_emergency_closures(id,business,service_type,starts_at,reason,created_by) VALUES(${closureId},'Corner Deli','pickup','2026-08-13T16:00:00Z','Test closure','availability-test')`;
    assert.equal((await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-13T17:00:00Z") })).sourceRule, "emergency_closure");
    await sql`UPDATE ordering_emergency_closures SET reopened_at='2026-08-13T16:30:00Z',reopened_by='availability-test' WHERE id=${closureId}`;
    assert.equal((await resolveOrderingAvailability({ business: "Corner Deli", serviceType: "pickup", at: new Date("2026-08-13T17:00:00Z") })).orderable, true);
  } finally {
    await sql`DELETE FROM ordering_emergency_closures WHERE id=${closureId}`;
    await sql`DELETE FROM ordering_operating_windows WHERE id=${windowId}`;
  }
}

integration().then(() => console.log("Ordering availability validation passed.")).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
