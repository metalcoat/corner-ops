import { createHmac, randomUUID } from "node:crypto";
import { localValidationEnv } from "../scripts/validation-env";
import { getSql } from "../src/lib/db";
import { expect, test } from "@playwright/test";

localValidationEnv();

const roles = ["employee", "manager", "owner"] as const;
const employeeIds = Object.fromEntries(roles.map((role) => [role, randomUUID()]));
test.beforeAll(async () => {
  for (const role of roles) {
    await getSql()`INSERT INTO employees(id,business,name,position,role_group,pos_role,active,pin_enabled,pin_hash)
      VALUES(${employeeIds[role]},'Corner Deli',${`Playwright settings ${role}`},'Counter','In-House',${role},TRUE,TRUE,${randomUUID()})`;
  }
});
test.afterAll(async () => {
  await getSql()`DELETE FROM employees WHERE id=ANY(${Object.values(employeeIds)}::uuid[])`;
});

function posCookie(role: "employee" | "manager" | "owner", expiresAt = Date.now() + 60_000) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  const payload = { employeeId: employeeIds[role], business: "Corner Deli", name: `Playwright ${role}`, position: role, posRole: role, issuedAt: Date.now(), expiresAt, clockInRequired: false };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("missing and expired sessions show Manager Unlock and preserve the requested route", async ({ page, context, baseURL }) => {
  await page.goto("/pos/deli/settings/hardware");
  await expect(page.getByRole("region", { name: "Manager authorization required" })).toBeVisible();
  await expect(page).toHaveURL(/\/pos\/deli\/settings\/hardware$/);
  await context.addCookies([{ name: "corner_ops_pos", value: posCookie("manager", Date.now() - 1), url: baseURL! }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "MANAGER AUTHORIZATION REQUIRED" })).toBeVisible();
});

test("an authenticated employee is denied while manager and owner sessions open settings directly", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "corner_ops_pos", value: posCookie("employee"), url: baseURL! }]);
  await page.goto("/pos/deli/settings");
  await expect(page.getByRole("heading", { name: "MANAGER ACCESS REQUIRED" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Printers & devices" })).toHaveCount(0);

  for (const role of ["manager", "owner"] as const) {
    await context.addCookies([{ name: "corner_ops_pos", value: posCookie(role), url: baseURL! }]);
    await page.goto("/pos/deli/settings/hardware");
    await expect(page.getByRole("heading", { name: "Printers & devices" })).toBeVisible();
    const response = await page.request.get("/api/ordering/settings/hardware");
    expect(response.status()).toBe(200);
  }
});

test("protected APIs distinguish authentication from role failure", async ({ request, browser, baseURL }) => {
  expect((await request.get("/api/ordering/settings/hardware")).status()).toBe(401);
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: "corner_ops_pos", value: posCookie("employee"), url: baseURL! }]);
  expect((await context.request.get("/api/ordering/settings/hardware")).status()).toBe(403);
  await context.close();
});


test("a signed employee cookie cannot grant a role missing from the employee record", async ({ context, baseURL }) => {
  const body = Buffer.from(JSON.stringify({
    employeeId: employeeIds.employee, business: "Corner Deli", name: "Outdated owner role",
    position: "Counter", posRole: "owner", issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
    clockInRequired: false,
  })).toString("base64url");
  const value = `${body}.${createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url")}`;
  await context.addCookies([{ name: "corner_ops_pos", value, url: baseURL! }]);
  expect((await context.request.get("/api/ordering/settings/hardware")).status()).toBe(403);
});
