#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";

loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("POS fixture requires local PostgreSQL.");
process.env.DATABASE_DRIVER="postgres";
process.env.DATABASE_URL=`postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

async function main(){
  const {getSql}=await import("../src/lib/db");
  const {hashEmployeePin}=await import("../src/lib/pos-auth");
  const sql=getSql();
  const mode=process.argv[2];
  const rows=await sql`SELECT id FROM employees WHERE business='Corner Deli' AND name LIKE 'Playwright POS Employee %'`;
  async function removeFixtureEmployee(employeeId:string){
    await sql`DELETE FROM ordering_print_jobs WHERE order_id IN (SELECT id FROM ordering_orders WHERE created_by=${employeeId})`;
    await sql`DELETE FROM ordering_payment_transactions WHERE order_id IN (SELECT id FROM ordering_orders WHERE created_by=${employeeId})`;
    await sql`DELETE FROM ordering_orders WHERE created_by=${employeeId}`;
    await sql`DELETE FROM time_entries WHERE employee_id=${employeeId}`;
    await sql`DELETE FROM employees WHERE id=${employeeId}`;
  }
  if(mode==="cleanup"){
    for(const row of rows)await removeFixtureEmployee(String(row.id));
    return;
  }
  const activePin=process.env.POS_TEST_ACTIVE_PIN, idlePin=process.env.POS_TEST_IDLE_PIN;
  if(!/^\d{4}$/.test(activePin||"")||!/^\d{4}$/.test(idlePin||"")||activePin===idlePin) throw new Error("Two distinct four-digit fixture PINs are required.");
  for(const row of rows)await removeFixtureEmployee(String(row.id));
  const activeId=randomUUID(),idleId=randomUUID();
  await sql`INSERT INTO employees(id,business,name,pin_hash,pin_enabled,position,role_group,active) VALUES
    (${activeId},'Corner Deli','Playwright POS Employee Active',${hashEmployeePin("Corner Deli",activePin!)},TRUE,'Pizza','In-House',TRUE),
    (${idleId},'Corner Deli','Playwright POS Employee Idle',${hashEmployeePin("Corner Deli",idlePin!)},TRUE,'Counter','In-House',TRUE)`;
  await sql`INSERT INTO time_entries(id,business,employee_id,employee_name,position,role_group,clock_in,source,status)
    VALUES(${randomUUID()},'Corner Deli',${activeId},'Playwright POS Employee Active','Pizza','In-House',NOW(),'Playwright fixture','Open')`;
}
main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
