// Card sales on the MX terminal through the real POS screens and API routes.
// Run with `npm run test:mx-terminal:e2e` (scripts/mx-terminal-e2e.ts), which
// starts the app against the local MX stand-in and cleans up afterwards.
import { expect, test, type Page } from "@playwright/test";

// The register is a touchscreen.
test.use({ hasTouch: true });
// One terminal: sales must not overlap.
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const standIn = process.env.MX_STAND_IN_URL!;
const scriptNextSale = (next: Record<string, unknown>) => fetch(`${standIn}/__stand-in/next`, { method: "POST", body: JSON.stringify(next) });
const standInState = async () => (await fetch(`${standIn}/__stand-in/state`)).json() as Promise<{ salesSent: number; completions: Record<string, string>[] }>;

/** Signs in as the fixture manager at the payment station and builds a $15.50 pickup order, ready for checkout. */
async function orderAtPaymentStation(page: Page) {
  await page.context().addCookies([{ name: "corner_ops_pos", value: process.env.MX_E2E_POS_COOKIE!, url: process.env.POS_BASE_URL! }]);
  await page.addInitScript((key) => localStorage.setItem("corner-ops-station-key", key), process.env.MX_E2E_STATION_KEY!);
  // Live phone calls on the dev box would cover the screen; the test never touches them.
  await page.route("**/api/ordering/calls", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { calls: [], aiCalls: [] } }) : route.abort()));
  const menu = page.waitForResponse((response) => response.url().includes("/api/ordering/menu?") && response.ok());
  await page.goto("/pos/deli");
  await menu;
  await page.getByRole("button", { name: /CUSTOMER/ }).click();
  await page.getByPlaceholder("3155551212 or Sarah Smith").fill(process.env.MX_E2E_CUSTOMER_PHONE!);
  await page.getByRole("button", { name: /Terminal Test/ }).click();
  await page.getByRole("button", { name: "Pizza and Wings", exact: true }).click();
  // Menu items need a touch: with a mouse the menu panel captures the pointer for drag-scrolling.
  await page.getByRole("button", { name: /^Pizza From / }).tap();
  const pizza = page.getByRole("dialog", { name: "Configure Pizza" });
  await pizza.getByText('Jumbo Thin 16"', { exact: true }).click();
  await pizza.getByRole("button", { name: /add to order/i }).click();
  await expect(page.getByText("1× Pizza")).toBeVisible();
}
const terminalDialog = (page: Page) => page.getByRole("dialog", { name: /Card terminal|Card approved/ });

test("checkout puts the balance on the terminal right away and asks for the tip after the card", async ({ page }) => {
  await orderAtPaymentStation(page);
  const before = await standInState();
  await scriptNextSale({ statuses: ["SENTTOTERMINAL", "SENTTOTERMINAL", "Approved"] });
  await page.getByRole("button", { name: "CHECKOUT", exact: true }).click();

  // No CREDIT press: the terminal already has the sale.
  const dialog = terminalDialog(page);
  await expect(dialog).toContainText("$15.50");
  await expect(dialog).toContainText(/can tap, insert, or swipe now/);
  expect((await standInState()).salesSent).toBe(before.salesSent + 1);

  await expect(page.getByRole("heading", { name: "Card approved: add a tip?" })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: /^18%/ }).click();

  const receipt = page.getByRole("dialog", { name: "Print receipt" });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await receipt.getByRole("button", { name: "NO RECEIPT" }).click();
  await expect(terminalDialog(page)).toHaveCount(0);
  const completion = (await standInState()).completions.at(-1)!;
  expect({ amount: completion.amount, tip: completion.tip }).toEqual({ amount: "18.29", tip: "2.79" });
});

test("cash waits until the terminal sale is cancelled, then the terminal can be used again", async ({ page }) => {
  await orderAtPaymentStation(page);
  await scriptNextSale({ statuses: ["SENTTOTERMINAL"] });
  await page.getByRole("button", { name: "CHECKOUT", exact: true }).click();
  const dialog = terminalDialog(page);
  await expect(dialog).toContainText(/can tap, insert, or swipe now/);
  await dialog.getByRole("button", { name: "STOP WAITING" }).click();
  await expect(terminalDialog(page)).toHaveCount(0);

  // The terminal may still charge the card, so cash is refused.
  await page.getByRole("button", { name: "CASH", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Order #/ }).getByRole("alert")).toContainText(/The terminal may still charge the card for this order/);

  // The red X on the terminal: MX reports the sale cancelled, and a new card sale goes through.
  await fetch(`${standIn}/__stand-in/cancel-pending`, { method: "POST" });
  await scriptNextSale({ statuses: ["Approved"] });
  await page.getByRole("button", { name: "CREDIT", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card approved: add a tip?" })).toBeVisible({ timeout: 15_000 });
  await terminalDialog(page).getByRole("button", { name: "NO TIP" }).click();
  await page.getByRole("dialog", { name: "Print receipt" }).getByRole("button", { name: "NO RECEIPT" }).click();
  expect((await standInState()).completions.at(-1)).toMatchObject({ amount: "15.50", tip: "0.00" });
});

test("a declined card is shown as final and nothing is charged", async ({ page }) => {
  await orderAtPaymentStation(page);
  const before = await standInState();
  await scriptNextSale({ statuses: ["SENTTOTERMINAL", "Declined"] });
  await page.getByRole("button", { name: "CHECKOUT", exact: true }).click();
  const dialog = terminalDialog(page);
  await expect(dialog.getByRole("alert")).toContainText("INSUFFICIENT FUNDS", { timeout: 15_000 });
  await dialog.getByRole("button", { name: "CLOSE" }).click();
  await expect(page.getByText("Amount due")).toBeVisible();
  expect((await standInState()).completions.length).toBe(before.completions.length);
});
