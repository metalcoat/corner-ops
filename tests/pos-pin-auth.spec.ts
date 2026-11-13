import { loadEnvFile } from "node:process";
import { Client } from "pg";
import { expect, test } from "@playwright/test";
if (process.env.POS_TEST_ENV_FILE) loadEnvFile(process.env.POS_TEST_ENV_FILE);

async function resetIdleClock() {
  const connectionString=process.env.VALIDATION_DATABASE_URL;
  if (!connectionString || (!/test|regression/.test(new URL(connectionString).pathname) && !(process.env.ORDERING_AUDIT_DATABASE==='1'&&process.env.CI==='true'))) throw new Error("PIN fixtures require an explicitly isolated test database.");
  const db=new Client({connectionString}); await db.connect();
  try { await db.query("DELETE FROM time_entries WHERE employee_id IN(SELECT id FROM employees WHERE business='Corner Deli' AND name='Playwright POS Employee Idle')"); }
  finally { await db.end(); }
}

async function enterPin(page: import("@playwright/test").Page,pin:string){for(const digit of pin)await page.getByRole("button",{name:digit,exact:true}).click();}

test("Deli POS uses PIN, prompts explicit clock-in, and locks without clock-out",async({page,context})=>{
  const active=process.env.POS_TEST_ACTIVE_PIN,idle=process.env.POS_TEST_IDLE_PIN;
  if(!active||!idle)throw new Error("POS fixture PIN environment is required");
  await resetIdleClock();
  try {
  await page.goto("/pos/deli");
  await expect(page.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await enterPin(page,active);
  await expect(page.getByText("Playwright POS Employee Active",{exact:true})).toBeVisible();
  const posCookie=(await context.cookies()).find((item)=>item.name==="corner_ops_pos");
  expect(posCookie).toBeTruthy();
  expect(posCookie?.secure).toBe(false);
  const posPayload=JSON.parse(Buffer.from(posCookie!.value.split(".")[0],"base64url").toString("utf8")) as Record<string,unknown>;
  expect(posPayload.pin).toBeUndefined();
  expect(posPayload.pinHash).toBeUndefined();
  expect(posCookie!.value.includes(active)).toBe(false);
  const backOffice=await page.request.get("/api/banking?business=Corner%20Deli");
  expect(backOffice.status()).toBe(401);
  await page.getByRole("button",{name:"LOG OUT"}).click();
  await expect(page.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await enterPin(page,idle);
  await expect(page.getByText("You're not clocked in.")).toBeVisible();
  await page.getByRole("button",{name:"CLOCK IN & CONTINUE"}).dblclick();
  await expect(page.getByText("Playwright POS Employee Idle",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"LOG OUT"}).click();
  await enterPin(page,idle);
  await expect(page.getByText("Playwright POS Employee Idle",{exact:true})).toBeVisible();
  await expect(page.getByText("You're not clocked in.")).toHaveCount(0);
  } finally { await resetIdleClock(); }
});

test("manual lock preserves the order and synchronizes POS and kitchen tabs",async({page,context})=>{
  const active=process.env.POS_TEST_ACTIVE_PIN;
  if(!active)throw new Error("POS fixture PIN environment is required");
  await page.goto("/pos/deli"); await enterPin(page,active);
  await page.getByLabel("Search menu").fill("Pizza Logs");
  await page.getByRole("button",{name:/^Pizza Logs /}).click();
  await page.getByRole("dialog",{name:"Configure Pizza Logs"}).getByRole("button",{name:"ADD TO ORDER"}).click();
  await expect(page.getByRole("article").filter({hasText:"Pizza Logs"})).toBeVisible();
  await page.evaluate(()=>{(window as typeof window&{auditLockMarker?:string}).auditLockMarker='preserve';});
  const kitchen=await context.newPage(); await kitchen.goto("/pos/deli/kitchen");
  await expect(kitchen.getByText("Corner Deli Kitchen",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"LOG OUT"}).click();
  await expect(page.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await expect(kitchen.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await expect(kitchen.getByRole("heading",{name:"Corner Deli Kitchen",exact:true})).toHaveCount(0);
  await enterPin(page,active);
  await expect(page.getByRole("article").filter({hasText:"Pizza Logs"})).toBeVisible();
  expect(await page.evaluate(()=>(window as typeof window&{auditLockMarker?:string}).auditLockMarker)).toBe('preserve');
});
