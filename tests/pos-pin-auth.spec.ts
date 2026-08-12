import { loadEnvFile } from "node:process";
import { expect, test } from "@playwright/test";
loadEnvFile("/opt/corner-ops/.env");

async function enterPin(page: import("@playwright/test").Page,pin:string){for(const digit of pin)await page.getByRole("button",{name:digit,exact:true}).click();}

test("Deli POS uses PIN, prompts explicit clock-in, and locks without clock-out",async({page,request})=>{
  const active=process.env.POS_TEST_ACTIVE_PIN,idle=process.env.POS_TEST_IDLE_PIN;
  if(!active||!idle)throw new Error("POS fixture PIN environment is required");
  await page.goto("/pos/deli");
  await expect(page.getByRole("region",{name:"Corner Deli employee PIN login"})).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await enterPin(page,active);
  await expect(page.getByText("Playwright POS Employee Active",{exact:true})).toBeVisible();
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
