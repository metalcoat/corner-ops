import { expect, test } from "@playwright/test";

test("in-store kiosk loads the customer-safe menu and starts a cart", async ({ page }) => {
  await page.goto("/kiosk/deli");
  await expect(page.getByText("CORNER DELI SELF-SERVICE", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Search menu")).toBeVisible();
  const firstItem = page.locator(".menuItem:not(:disabled)").first();
  await expect(firstItem).toBeVisible();
  await firstItem.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: /Add to order/i })).toBeVisible();
});
