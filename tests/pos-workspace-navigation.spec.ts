import { loadEnvFile } from "node:process";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";

if (process.env.POS_TEST_ENV_FILE) loadEnvFile(process.env.POS_TEST_ENV_FILE);

function isolatedDatabase() {
  const connectionString=process.env.VALIDATION_DATABASE_URL;
  if (!connectionString || (!/test|regression/.test(new URL(connectionString).pathname) && !(process.env.ORDERING_AUDIT_DATABASE==='1'&&process.env.CI==='true'))) throw new Error("Workspace fixtures require an explicitly isolated test database.");
  return new Client({connectionString});
}

async function signIn(page: Page) {
  const pin = process.env.POS_TEST_ACTIVE_PIN;
  if (!pin) throw new Error("POS_TEST_ACTIVE_PIN is required");
  await page.goto("/pos/deli");
  for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByText("Corner Deli POS", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /CUSTOMER/ })).toBeVisible();
}

test("POS workspace tabs preserve the unfinished order without a document reload", async ({ page }) => {
  isolatedDatabase(); // Validate isolation before creating any customer/order fixture.
  await signIn(page);
  const suffix = String(Date.now()).slice(-7);
  const phone = `315${suffix}`;
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
    await expect(page.getByText(/Held order #/)).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: "Pizza Logs" })).toContainText("Shell state note");
    await page.getByRole("button", { name: "CHECKOUT", exact: true }).click();
    await expect(page.getByRole("heading", { name: /CHECKOUT\s+Order #/i })).toBeVisible();
    for (const name of ["Clear payment amount", /HOUSE ACCOUNT/]) {
      const action=page.getByRole("button",{name});
      await action.scrollIntoViewIfNeeded();
      expect(await action.evaluate((element)=>{const rect=element.getBoundingClientRect();return element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));})).toBe(true);
    }
    await page.getByRole("button", { name: "BACK TO ORDER", exact: true }).click();
    await ordersLink.click();
    await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { __cornerOpsShellMarker?: string }).__cornerOpsShellMarker)).toBe("mounted");
  } finally {
    if (/^[0-9a-f-]{36}$/i.test(customer.customer.id)) {
      const db=isolatedDatabase(); await db.connect();
      try {
        await db.query("DELETE FROM ordering_print_jobs WHERE order_id IN(SELECT id FROM ordering_orders WHERE customer_id=$1)",[customer.customer.id]);
        await db.query("DELETE FROM ordering_orders WHERE customer_id=$1",[customer.customer.id]);
        await db.query("DELETE FROM ordering_customers WHERE id=$1 AND first_name='Workspace' AND last_name='Navigation'",[customer.customer.id]);
      } finally { await db.end(); }
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
      const link=nav.getByRole("link", { name: new RegExp(label) });
      await expect(link).toBeVisible();
      await link.scrollIntoViewIfNeeded();
      expect(await link.evaluate((element)=>{const rect=element.getBoundingClientRect();return element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));})).toBe(true);
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
