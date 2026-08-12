import { loadEnvFile } from "node:process";
import { expect, test } from "@playwright/test";
loadEnvFile("/opt/corner-ops/.env");

async function enterPin(page: import("@playwright/test").Page,pin:string){for(const digit of pin)await page.getByRole("button",{name:digit,exact:true}).click();}

test("Deli POS uses PIN, prompts explicit clock-in, and locks without clock-out",async({page,request,context})=>{
  const active=process.env.POS_TEST_ACTIVE_PIN,idle=process.env.POS_TEST_IDLE_PIN;
  if(!active||!idle)throw new Error("POS fixture PIN environment is required");
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
  await page.getByRole("button",{name:"LOCK / SWITCH EMPLOYEE"}).click();
  await expect(page.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await enterPin(page,idle);
  await expect(page.getByText("You're not clocked in.")).toBeVisible();
  await page.getByRole("button",{name:"CLOCK IN & CONTINUE"}).dblclick();
  await expect(page.getByText("Playwright POS Employee Idle",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"LOCK / SWITCH EMPLOYEE"}).click();
  await enterPin(page,idle);
  await expect(page.getByText("Playwright POS Employee Idle",{exact:true})).toBeVisible();
  await expect(page.getByText("You're not clocked in.")).toHaveCount(0);
  void request;
});

test("manual lock preserves the order and synchronizes POS and kitchen tabs",async({page,context})=>{
  const active=process.env.POS_TEST_ACTIVE_PIN;
  if(!active)throw new Error("POS fixture PIN environment is required");
  await page.goto("/pos/deli"); await enterPin(page,active);
  await page.getByLabel("Search menu").fill("Pizza Logs");
  await page.getByRole("button",{name:/^Pizza Logs /}).click();
  await page.getByRole("dialog",{name:"Configure Pizza Logs"}).getByRole("button",{name:"ADD TO ORDER"}).click();
  const kitchen=await context.newPage(); await kitchen.goto("/pos/deli/kitchen");
  await expect(kitchen.getByText("Corner Deli Kitchen",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"LOCK / SWITCH EMPLOYEE"}).click();
  await expect(page.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await expect(kitchen.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await enterPin(page,active);
  await expect(page.getByRole("article").filter({hasText:"Pizza Logs"})).toBeVisible();
});
