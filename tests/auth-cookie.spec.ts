import { loadEnvFile } from "node:process";
import { expect, test } from "@playwright/test";

loadEnvFile("/opt/corner-ops/.env");

test("owner session persists across local HTTP navigation", async ({ page, context }) => {
  const password = process.env.APP_PASSWORD;
  if (!password) throw new Error("APP_PASSWORD is required for the local authentication browser test");
  await page.goto("/signin");
  await page.getByLabel("Email").fill(process.env.APP_EMAIL || "crfrary@gmail.com");
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL(/\/ops/),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);

  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.status()).toBe(200);
  expect((await sessionResponse.json()).authenticated).toBe(true);
  await page.goto("/ops/employees");
  await expect(page.getByRole("heading", { name: "Employees", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Owner access required" })).toHaveCount(0);

  const cookie = (await context.cookies()).find((item) => item.name === "corner_ops_session");
  expect(cookie).toBeTruthy();
  expect(cookie?.secure).toBe(false);
  const encoded = cookie!.value.split(".")[0];
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  expect(payload.password).toBeUndefined();
  expect(payload.pin).toBeUndefined();
  expect(payload.pinHash).toBeUndefined();
});
