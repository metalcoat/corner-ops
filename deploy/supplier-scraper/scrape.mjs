// Website price job: signs in to each supplier's ordering site with the deli's
// own account, opens the order guide, and sends today's prices to Corner Ops.
//
// It doesn't depend on the site's layout. It reads the product data the page
// itself downloads (see src/lib/supplier-web-extract.ts), and falls back to the
// site's own Export/Download button. Each supplier keeps its own browser profile,
// so "remember this device" sign-ins (and their verification codes) stick.
//
// Runs in its own container (docker compose --profile tools run supplier-prices),
// started by deploy/supplier-prices-sync.sh --website on a timer.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dedupeProducts, extractProducts, productsToCsv } from "./supplier-web-extract.ts";

const APP = process.env.APP_INTERNAL_URL || "http://app:3000";
const SECRET = process.env.CRON_SECRET || "";
const DEBUG = process.env.DEBUG_DIR || "/debug";
const PROFILES = process.env.PROFILE_DIR || "/profiles";
const HEADED = process.env.HEADED === "1";

// Default sign-in and order-guide pages. Any of these can be overridden in
// /opt/corner-ops/.env (e.g. SYSCO_ORDER_GUIDE_URL) if a site moves things.
const SUPPLIERS = [
  { name: "Sysco", key: "SYSCO", login: "https://shop.sysco.com/auth/login", guide: "https://shop.sysco.com/app/lists" },
  { name: "US Foods", key: "USFOODS", login: "https://order.usfoods.com/desktop/login", guide: "https://order.usfoods.com/desktop/lists" },
  { name: "Performance Foodservice", key: "PFG", login: "https://www.customerfirstsolutions.com/", guide: "" },
];

const only = (process.argv[2] || "").toLowerCase();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(DEBUG, { recursive: true });

async function report(supplier, body) {
  const response = await fetch(`${APP}/api/cron/supplier-prices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ supplier, source: "website", ...body }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Corner Ops answered ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

async function visible(locator) {
  try {
    return await locator.first().isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

const USER_FIELD = 'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[name*="login" i]';
const PASSWORD_FIELD = 'input[type="password"]';
const CODE_FIELD = 'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[name*="otp" i], input[name*="passcode" i]';
const SUBMIT = 'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Next"), button:has-text("Continue"), button:has-text("Verify")';

async function submit(page, field) {
  const button = page.locator(SUBMIT);
  if (await visible(button)) await button.first().click().catch(() => field.press("Enter"));
  else await field.press("Enter");
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
}

/** Signs in if the page is asking; handles username-then-password sites and verification codes. */
async function signIn(page, supplier, user, password) {
  for (let step = 0; step < 4; step++) {
    const passwordField = page.locator(PASSWORD_FIELD), userField = page.locator(USER_FIELD), codeField = page.locator(CODE_FIELD);
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 5_000);
    if (await visible(codeField) && /code|verif|one-time|passcode|authenticat/i.test(bodyText)) {
      const code = process.env[`${supplier.key}_CODE`];
      if (!code) return { status: "needs_code", message: `${supplier.name} sent a verification code. Add ${supplier.key}_CODE=<the code> to /opt/corner-ops/.env and run the price job again, then remove it.` };
      await codeField.first().fill(code);
      const remember = page.getByLabel(/remember|trust this|don.t ask/i);
      if (await visible(remember)) await remember.first().check().catch(() => {});
      await submit(page, codeField.first());
      continue;
    }
    if (await visible(passwordField)) {
      if (await visible(userField) && !(await userField.first().inputValue().catch(() => ""))) await userField.first().fill(user);
      await passwordField.first().fill(password);
      const remember = page.getByLabel(/remember|keep me signed in|stay signed in/i);
      if (await visible(remember)) await remember.first().check().catch(() => {});
      await submit(page, passwordField.first());
      continue;
    }
    if (await visible(userField)) {
      await userField.first().fill(user);
      await submit(page, userField.first());
      continue;
    }
    return { status: "signed_in" };
  }
  if (await visible(page.locator(PASSWORD_FIELD))) return { status: "needs_login", message: `${supplier.name} didn't accept the sign-in. Check ${supplier.key}_USERNAME and ${supplier.key}_PASSWORD in /opt/corner-ops/.env.` };
  return { status: "signed_in" };
}

/** Scrolls until the list stops growing (order guides load more items as you scroll). */
async function loadEverything(page) {
  let same = 0, last = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    const more = page.locator('button:has-text("Load more"), button:has-text("Show more"), a:has-text("Load more"), a:has-text("Show more"), button:has-text("View all")');
    if (await visible(more)) await more.first().click().catch(() => {});
    const height = await page.evaluate(() => {
      const scrollers = [document.scrollingElement, ...document.querySelectorAll("*")].filter((el) => el && el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== "hidden");
      for (const el of scrollers) el.scrollTop = el.scrollHeight;
      return scrollers.reduce((sum, el) => sum + el.scrollHeight, 0);
    });
    await page.waitForTimeout(1_000);
    same = height === last ? same + 1 : 0;
    last = height;
  }
}

/** The site's own export, if there is one: CSV as-is, Excel converted to CSV. */
async function tryExport(page, supplier) {
  const button = page.locator('button:has-text("Export"), a:has-text("Export"), button:has-text("Download"), a:has-text("Download"), [aria-label*="export" i], [aria-label*="download" i]');
  if (!(await visible(button))) return null;
  try {
    const waiting = page.waitForEvent("download", { timeout: 20_000 });
    await button.first().click();
    // Some sites open a menu first: pick CSV, else Excel.
    const option = page.locator('text=/^\\s*CSV/i, text=/comma/i, text=/Excel/i, text=/xlsx/i');
    if (await visible(option)) await option.first().click().catch(() => {});
    const confirm = page.locator('button:has-text("Export"), button:has-text("Download")');
    if (await visible(confirm)) await confirm.last().click().catch(() => {});
    const download = await waiting;
    const file = `${DEBUG}/${supplier.key}-${stamp}-${download.suggestedFilename()}`;
    await download.saveAs(file);
    if (/\.(xlsx|xls)$/i.test(file)) {
      const XLSX = await import("xlsx");
      const book = XLSX.read(readFileSync(file));
      return XLSX.utils.sheet_to_csv(book.Sheets[book.SheetNames[0]]);
    }
    return readFileSync(file, "utf8");
  } catch (error) {
    console.log(`${supplier.name}: export didn't work (${error.message.split("\n")[0]})`);
    return null;
  }
}

async function run(supplier) {
  const user = process.env[`${supplier.key}_USERNAME`], password = process.env[`${supplier.key}_PASSWORD`];
  if (!user || !password) {
    console.log(`${supplier.name}: skipped (no ${supplier.key}_USERNAME / ${supplier.key}_PASSWORD)`);
    return;
  }
  const loginUrl = process.env[`${supplier.key}_LOGIN_URL`] || supplier.login;
  const guideUrl = process.env[`${supplier.key}_ORDER_GUIDE_URL`] || supplier.guide;
  const context = await chromium.launchPersistentContext(`${PROFILES}/${supplier.key}`, {
    headless: !HEADED,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    locale: "en-US",
    timezoneId: "America/New_York",
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const page = context.pages()[0] || (await context.newPage());
  const captured = [];
  page.on("response", async (response) => {
    try {
      const type = response.headers()["content-type"] || "";
      if (!type.includes("json") || response.request().method() === "OPTIONS") return;
      if (/analytics|telemetry|segment|optimizely|newrelic|datadog|google|doubleclick|hotjar/i.test(response.url())) return;
      const body = await response.text();
      if (body.length > 20_000_000) return;
      captured.push({ url: response.url(), json: JSON.parse(body) });
    } catch {
      // Redirects, empty bodies, and non-JSON are expected.
    }
  });
  const shot = async (why) => {
    const path = `${DEBUG}/${supplier.key}-${stamp}-${why}.png`;
    await page.screenshot({ path, fullPage: false }).catch(() => {});
    return path;
  };
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);
    const login = await signIn(page, supplier, user, password);
    if (login.status !== "signed_in") {
      await shot(login.status);
      console.log(`${supplier.name}: ${login.message}`);
      await report(supplier.name, { status: login.status, message: login.message });
      return;
    }
    if (guideUrl) await page.goto(guideUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    else {
      const link = page.locator('a:has-text("Order Guide"), a:has-text("Order guide"), a:has-text("My Lists"), a:has-text("Lists"), button:has-text("Order Guide")');
      if (await visible(link)) await link.first().click();
    }
    await page.waitForTimeout(6_000);
    // Signed in, but the site asked again (session expired mid-way).
    if (await visible(page.locator(PASSWORD_FIELD))) {
      const again = await signIn(page, supplier, user, password);
      if (again.status !== "signed_in") {
        await shot(again.status);
        await report(supplier.name, { status: again.status, message: again.message });
        return;
      }
      if (guideUrl) await page.goto(guideUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(6_000);
    }
    await loadEverything(page);
    await page.waitForTimeout(2_000);

    const products = dedupeProducts(captured.flatMap((c) => extractProducts(c.json)));
    let csv = products.length >= 3 ? productsToCsv(products) : null;
    if (!csv) csv = await tryExport(page, supplier);
    if (!csv) {
      const picture = await shot("no-products");
      // What the page loaded, for tuning: URLs and top-level keys only.
      writeFileSync(`${DEBUG}/${supplier.key}-${stamp}-responses.txt`, captured.map((c) => `${c.url}\n  keys: ${Object.keys(c.json || {}).slice(0, 20).join(", ")}`).join("\n"));
      const message = `Signed in, but found no prices on ${page.url()}. Screenshot: ${picture.replace(DEBUG, "/opt/corner-ops/supplier-prices/_website")}. Set ${supplier.key}_ORDER_GUIDE_URL to the order guide page.`;
      console.log(`${supplier.name}: ${message}`);
      await report(supplier.name, { status: "no_products", message });
      return;
    }
    writeFileSync(`${DEBUG}/${supplier.key}-latest.csv`, csv);
    console.log(`${supplier.name}: ${await report(supplier.name, { csv })}`);
  } catch (error) {
    const picture = await shot("error");
    const message = `${error.message.split("\n")[0]} (screenshot ${picture.replace(DEBUG, "/opt/corner-ops/supplier-prices/_website")})`;
    console.error(`${supplier.name}: ${message}`);
    await report(supplier.name, { status: "failed", message }).catch((e) => console.error(e.message));
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

if (!SECRET) {
  console.error("CRON_SECRET is missing; the price job can't send prices to Corner Ops.");
  process.exit(1);
}
for (const supplier of SUPPLIERS) {
  if (only && supplier.key.toLowerCase() !== only && supplier.name.toLowerCase() !== only) continue;
  // One supplier's problem never stops the others.
  await run(supplier).catch(async (error) => {
    console.error(`${supplier.name}: ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
    await report(supplier.name, { status: "failed", message: error.message.split("\n")[0] }).catch(() => {});
  });
}
