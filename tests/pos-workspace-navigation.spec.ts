import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { expect, test, type Page } from "@playwright/test";

loadEnvFile("/opt/corner-ops/.env");

async function signIn(page: Page) {
  const pin = process.env.POS_TEST_ACTIVE_PIN;
  if (!pin) throw new Error("POS_TEST_ACTIVE_PIN is required");
  await page.goto("/pos/deli");
  for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByText("Corner Deli POS", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /CUSTOMER/ })).toBeVisible();
}

test("POS workspace tabs preserve the unfinished order without a document reload", async ({ page }) => {
  await signIn(page);
  const suffix = String(Date.now()).slice(-7);
  const phone = `31555${suffix}`.slice(0, 10);
  const created = await page.evaluate(async (customerPhone) => {
    const response = await fetch("/api/ordering/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Workspace", lastName: "Navigation", phone: customerPhone }),
    });
    return { status: response.status, body: await response.json() as { customer: { id: string } } };
  }, phone);
  expect(created.status).toBe(201);
  const customer = created.body;

  try {
    await page.getByRole("button", { name: /CUSTOMER/ }).click();
    await page.getByPlaceholder("3155551212 or Sarah Smith").fill(phone);
    await page.getByRole("button", { name: /Workspace Navigation/ }).click();

    await page.getByLabel("Search menu").fill("Pizza Logs");
    await page.getByRole("button", { name: /^Pizza Logs / }).click();
    const dialog = page.getByRole("dialog", { name: "Configure Pizza Logs" });
    await dialog.getByLabel("Item notes").fill("Shell state note");
    await dialog.getByRole("button", { name: "ADD TO ORDER" }).click();

    await page.evaluate(() => {
      (window as typeof window & { __cornerOpsShellMarker?: string }).__cornerOpsShellMarker = "mounted";
    });
    const initialNavigationEntries = await page.evaluate(() => performance.getEntriesByType("navigation").length);
    const nav = page.getByRole("navigation", { name: "Corner Deli POS workspaces" });

    const ordersLink = page.getByRole("link", { name: /orders/i });
    await ordersLink.click();
    await expect(ordersLink).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();

    await nav.getByRole("link", { name: "Customers", exact: true }).click();
    await expect(nav.getByRole("link", { name: "Customers", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Customers", exact: true })).toBeVisible();

    await page.goBack();
    await expect(ordersLink).toHaveAttribute("aria-current", "page");
    await page.goForward();
    await expect(nav.getByRole("link", { name: "Customers", exact: true })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Menu", exact: true }).click();

    await expect(page.getByRole("article").filter({ hasText: "Pizza Logs" })).toContainText("Shell state note");
    await expect(page.getByRole("button", { name: /Workspace Navigation/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pickup", exact: true })).toHaveClass(/active/);
    await expect(page.getByRole("button", { name: /^ASAP/ })).toHaveClass(/active/);
    expect(await page.evaluate(() => (window as typeof window & { __cornerOpsShellMarker?: string }).__cornerOpsShellMarker)).toBe("mounted");
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(initialNavigationEntries);

    await page.getByRole("button", { name: "HOLD", exact: true }).click();
    await expect(page.getByText(/Held order #/)).toBeVisible();
    await ordersLink.click();
    await page.locator(".ocOrder").filter({ hasText: "Workspace Navigation" }).first().click();
    await page.getByRole("button", { name: "OPEN CHECKOUT / PAY" }).click();
    await expect(page.getByRole("heading", { name: /Checkout · Order #/ })).toBeVisible();
    await page.getByRole("button", { name: "BACK TO ORDERS" }).click();
    await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
  } finally {
    if (/^[0-9a-f-]{36}$/i.test(customer.customer.id)) {
      execFileSync("docker", ["exec", "corner-ops-postgres", "psql", "-U", "cornerops", "-d", "cornerops", "-v", "ON_ERROR_STOP=1", "-c", `UPDATE ordering_orders SET customer_id=NULL WHERE customer_id='${customer.customer.id}'; DELETE FROM ordering_customers WHERE id='${customer.customer.id}' AND first_name='Workspace' AND last_name='Navigation'`]);
    }
  }
});

test("persistent workspace navigation stays compact across POS viewports", async ({ page }) => {
  await signIn(page);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const nav = page.getByRole("navigation", { name: "Corner Deli POS workspaces" });
    await expect(nav).toBeVisible();
    for (const label of ["Menu", "Customers", "Kitchen"]) {
      await expect(nav.getByRole("link", { name: new RegExp(label) })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: /orders/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /settings/i })).toBeVisible();
    await expect(page.getByText("DEV", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "HOLD", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= document.scrollingElement!.clientHeight)).toBe(true);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNav = page.getByRole("navigation", { name: "Corner Deli POS workspaces" });
  await expect(mobileNav).toBeVisible();
  await mobileNav.getByRole("link", { name: "Customers", exact: true }).click();
  await expect(mobileNav.getByRole("link", { name: "Customers", exact: true })).toHaveAttribute("aria-current", "page");
});
