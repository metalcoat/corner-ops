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

test("kiosk cart lists the customer's selected modifiers", async ({ page, request }) => {
  const response = await request.get("/api/customer/catalog?serviceType=pickup");
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json();
  const item = catalog.categories
    .flatMap((category: any) => category.items)
    .find((candidate: any) => candidate.available && candidate.modifiers.some((group: any) =>
      group.options.some((option: any) => option.available && !option.defaultSelected),
    ));
  expect(item).toBeTruthy();
  const group = item.modifiers.find((candidate: any) =>
    candidate.options.some((option: any) => option.available && !option.defaultSelected),
  );
  const option = group.options.find((candidate: any) => candidate.available && !candidate.defaultSelected);

  await page.goto("/kiosk/deli");
  await page.getByLabel("Search menu").fill(item.displayName);
  await page.locator(".menuItem", { hasText: item.displayName }).first().click();
  const choice = page.getByRole("dialog").getByText(option.name, { exact: true }).locator("..").getByRole("checkbox").or(
    page.getByRole("dialog").getByText(option.name, { exact: true }).locator("..").getByRole("radio"),
  );
  await choice.click();
  await page.getByRole("button", { name: /Add to order/i }).click();
  await expect(page.locator(".orderCart")).toContainText(`${group.name}: ${option.name}`);
});
