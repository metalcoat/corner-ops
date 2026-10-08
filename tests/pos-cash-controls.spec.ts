import { loadEnvFile } from "node:process";
import { expect, test } from "@playwright/test";
loadEnvFile("/opt/corner-ops/.env");

test("manager can open the driver bulk cash-out workspace",async({page})=>{
  const pin=process.env.POS_TEST_ACTIVE_PIN;if(!pin)throw new Error("POS_TEST_ACTIVE_PIN is required");
  await page.goto("/pos/deli");
  for(const digit of pin)await page.getByRole("button",{name:digit,exact:true}).click();
  await page.goto("/pos/deli/drivers");
  await expect(page.getByRole("heading",{name:"Driver bulk cash-out"})).toBeVisible();
  await expect(page.getByText("DRIVER CASH CHECKOUT")).toBeVisible();
  await expect(page.getByText(/^Expected from \d+ orders?$/)).toBeVisible();
  await expect(page.getByRole("button",{name:/^CASH OUT/})).toBeDisabled();
});
