#!/usr/bin/env node
// Browser test of card sales on the MX terminal, end to end through the real
// POS screens and API routes, against the local MX stand-in.
//
//   npm run build && npm run test:mx-terminal:e2e
//
// Starts a separate copy of the built app on 127.0.0.1:3057 (the dev runtime
// on :3000 keeps its own settings), pointed at the stand-in and the private
// dev database. For the run, the Corner Deli payment station gets a test MX
// terminal and no customer display, and Corner Deli's printers are switched
// off so a test payment can never print a ticket in the store. The orders the
// test created (and their queued print jobs) are removed before the printers
// and the station are restored.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { MX_STAND_IN_TERMINAL, startMxStandIn } from "./lib/mx-stand-in";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("The MX terminal e2e test requires the private local PostgreSQL container.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
const PORT = 3057, BASE = `http://127.0.0.1:${PORT}`;
/** The fixture manager in the dev database; the test signs in as them without a PIN. */
const EMPLOYEE_ID = "11110000-0000-4000-8000-000000000001";

async function waitForHealth(server: ReturnType<typeof spawn>) {
  for (let i = 0; i < 120; i += 1) {
    if (server.exitCode !== null) throw new Error(`The app server exited (${server.exitCode}).`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The app server did not become healthy.");
}

/** Deletes rows, and everything that references them through foreign keys, children first. */
async function purge(sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<Record<string, any>[]>, raw: (text: string, values: unknown[]) => Promise<Record<string, any>[]>, table: string, ids: string[], depth = 0): Promise<void> {
  if (!ids.length || depth > 6) return;
  const refs = await sql`SELECT child.relname child_table, a.attname child_column, pa.attname parent_column,
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=child.oid AND attname='id' AND NOT attisdropped) child_has_id
    FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=c.confkey[1]
    WHERE c.contype='f' AND parent.relname=${table} AND array_length(c.conkey,1)=1`;
  for (const ref of refs) {
    const where = `"${ref.child_column}" IN (SELECT "${ref.parent_column}" FROM "${table}" WHERE id = ANY($1::uuid[]))`;
    if (ref.child_has_id) {
      const childIds = (await raw(`SELECT id::text FROM "${ref.child_table}" WHERE ${where}${ref.child_table === table ? " AND NOT (id = ANY($1::uuid[]))" : ""}`, [ids])).map((row) => String(row.id));
      await purge(sql, raw, ref.child_table, childIds, depth + 1);
    }
    if (ref.child_table !== table) await raw(`DELETE FROM "${ref.child_table}" WHERE ${where}`, [ids]);
  }
  await raw(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
}

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { encodePosSession } = await import("../src/lib/pos-auth");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const raw = async (text: string, values: unknown[]) => (await pool.query(text, values)).rows;
  const sql = getSql();
  const startedAt = new Date();
  const standIn = await startMxStandIn();
  const station = (await sql`SELECT * FROM ordering_payment_stations WHERE business='Corner Deli' AND station_mode='payment' AND active=TRUE LIMIT 1`)[0];
  const location = (await sql`SELECT id FROM ordering_hardware_locations WHERE business='Corner Deli' ORDER BY created_at LIMIT 1`)[0];
  const employee = (await sql`SELECT id,name,position,pos_role FROM employees WHERE id=${EMPLOYEE_ID} AND business='Corner Deli' AND active=TRUE AND pin_enabled=TRUE`)[0];
  if (!station || !location || !employee) throw new Error("The dev database needs a Corner Deli payment station, a hardware location, and the fixture manager.");
  const printers = (await sql`SELECT id FROM ordering_hardware_devices WHERE business='Corner Deli' AND device_type='printer' AND active=TRUE`).map((row) => String(row.id));
  const deviceId = randomUUID(), customerId = randomUUID(), phone = `31599${String(Date.now()).slice(-5)}`;
  let server: ReturnType<typeof spawn> | null = null, status = 1;
  try {
    if (printers.length) await sql`UPDATE ordering_hardware_devices SET active=FALSE WHERE id = ANY(${printers}::uuid[])`;
    await sql`INSERT INTO ordering_hardware_devices(id,business,location_id,name,device_key,device_type,role,adapter_key,adapter_config,created_by,updated_by)
      VALUES(${deviceId},'Corner Deli',${location.id},'E2E MX terminal',${`e2e-mx-${deviceId.slice(0, 8)}`},'payment_terminal','payment_terminal','mx-terminal',${JSON.stringify({ mxTerminalId: MX_STAND_IN_TERMINAL })}::jsonb,'mx-terminal-e2e','mx-terminal-e2e')`;
    await sql`UPDATE ordering_payment_stations SET payment_terminal_id=${deviceId},customer_display_enabled=FALSE WHERE id=${station.id}`;
    await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name) VALUES(${customerId},'Corner Deli','Terminal Test','Terminal','Test')`;
    await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,is_primary) VALUES(${randomUUID()},${customerId},${`+1${phone}`},${phone},TRUE)`;
    const now = Date.now();
    const cookie = encodePosSession({ employeeId: String(employee.id), business: "Corner Deli", name: String(employee.name), position: String(employee.position || ""), posRole: employee.pos_role === "owner" ? "owner" : "manager", issuedAt: now, expiresAt: now + 3_600_000, clockInRequired: false });

    server = spawn("node_modules/.bin/next", ["start", "-p", String(PORT), "-H", "127.0.0.1"], {
      env: { ...process.env, ...standIn.env, PORT: String(PORT), NODE_ENV: "production" }, stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForHealth(server);
    // Spawned asynchronously: the stand-in runs in this process and must keep answering while the browser tests run.
    const run = spawn("node_modules/.bin/playwright", ["test", "tests/mx-terminal.spec.ts", "--reporter=list", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, POS_BASE_URL: BASE, MX_E2E_POS_COOKIE: cookie, MX_E2E_STATION_KEY: String(station.station_key), MX_STAND_IN_URL: standIn.base, MX_E2E_CUSTOMER_PHONE: phone },
    });
    status = await new Promise<number>((resolve) => run.on("exit", (code) => resolve(code ?? 1)));
  } finally {
    server?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sql`UPDATE ordering_payment_stations SET payment_terminal_id=${station.payment_terminal_id},customer_display_enabled=${station.customer_display_enabled} WHERE id=${station.id}`;
    const orders = (await sql`SELECT id::text FROM ordering_orders WHERE business='Corner Deli' AND created_by=${EMPLOYEE_ID} AND created_at>=${startedAt}`).map((row) => String(row.id));
    await purge(sql as any, raw, "ordering_orders", orders);
    if (orders.length) await raw(`DELETE FROM ordering_mx_reversal_attempts WHERE order_id = ANY($1::uuid[])`, [orders]).catch(() => undefined);
    await purge(sql as any, raw, "ordering_customers", [customerId]);
    await sql`DELETE FROM ordering_hardware_devices WHERE id=${deviceId}`;
    // Only after the test orders and their print jobs are gone.
    if (printers.length) await sql`UPDATE ordering_hardware_devices SET active=TRUE WHERE id = ANY(${printers}::uuid[])`;
    await pool.end();
    await standIn.close();
    console.log(`Restored the payment station and ${printers.length} printer(s), and removed ${orders.length} test order(s).`);
  }
  process.exit(status);
}

main().catch((error) => { console.error(error); process.exit(1); });
