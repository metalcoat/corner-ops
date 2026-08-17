import { createHmac } from "node:crypto";
import { loadEnvFile } from "node:process";
import { expect, test } from "@playwright/test";

loadEnvFile("/opt/corner-ops/.env");

function posCookie(role: "employee" | "manager" | "owner", expiresAt = Date.now() + 60_000) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  const payload = { employeeId: `playwright-${role}`, business: "Corner Deli", name: `Playwright ${role}`, position: role, posRole: role, issuedAt: Date.now(), expiresAt, clockInRequired: false };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("missing and expired sessions show Manager Unlock and preserve the requested route", async ({ page, context }) => {
  await page.goto("/pos/deli/settings/hardware");
  await expect(page.getByRole("region", { name: "Manager authorization required" })).toBeVisible();
  await expect(page).toHaveURL(/\/pos\/deli\/settings\/hardware$/);
  await context.addCookies([{ name: "corner_ops_pos", value: posCookie("manager", Date.now() - 1), url: "http://127.0.0.1:3000" }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "MANAGER AUTHORIZATION REQUIRED" })).toBeVisible();
});

test("an authenticated employee is denied while manager and owner sessions open settings directly", async ({ page, context }) => {
  await context.addCookies([{ name: "corner_ops_pos", value: posCookie("employee"), url: "http://127.0.0.1:3000" }]);
  await page.goto("/pos/deli/settings");
  await expect(page.getByRole("heading", { name: "MANAGER ACCESS REQUIRED" })).toBeVisible();
  await expect(page.getByText("Hardware & print queue")).toHaveCount(0);

  for (const role of ["manager", "owner"] as const) {
    await context.addCookies([{ name: "corner_ops_pos", value: posCookie(role), url: "http://127.0.0.1:3000" }]);
    await page.goto("/pos/deli/settings/hardware");
    await expect(page.getByRole("heading", { name: "Hardware & print queue" })).toBeVisible();
    const response = await page.request.get("/api/ordering/settings/hardware");
    expect(response.status()).toBe(200);
  }
});

test("protected APIs distinguish authentication from role failure", async ({ request, browser }) => {
  expect((await request.get("/api/ordering/settings/hardware")).status()).toBe(401);
  const context = await browser.newContext();
  await context.addCookies([{ name: "corner_ops_pos", value: posCookie("employee"), url: "http://127.0.0.1:3000" }]);
  expect((await context.request.get("/api/ordering/settings/hardware")).status()).toBe(403);
  await context.close();
});
