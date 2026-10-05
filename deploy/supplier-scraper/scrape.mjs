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
import { dedupeProducts, extractProducts, extractSignInCode, joinSplitProducts, productsToCsv } from "./supplier-web-extract.ts";

const SECRET = process.env.CRON_SECRET || "";
const DEBUG = process.env.DEBUG_DIR || "/debug";
const PROFILES = process.env.PROFILE_DIR || "/profiles";
const HEADED = process.env.HEADED === "1";

// Default sign-in and order-guide pages. Any of these can be overridden in
// /opt/corner-ops/.env (e.g. SYSCO_ORDER_GUIDE_URL) if a site moves things.
const SUPPLIERS = [
  { name: "Sysco", key: "SYSCO", login: "https://shop.sysco.com/auth/login", guide: "https://shop.sysco.com/app/lists" },
  // The deli's order guide, then everything bought recently (catches items not on the guide).
  { name: "US Foods", key: "USFOODS", login: "https://order.usfoods.com/desktop/search/browse", guide: "https://order.usfoods.com/desktop/lists/view/OG-127949 https://order.usfoods.com/desktop/lists/view/recentlyPurchased" },
  { name: "Performance Foodservice", key: "PFG", login: "https://www.customerfirstsolutions.com/", guide: "" },
];

const only = (process.argv[2] || "").toLowerCase();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(DEBUG, { recursive: true });

// Where the app answers from inside this container: its Compose service name,
// its container name, or the host's port 3000 (host.docker.internal).
const APP_CANDIDATES = [...new Set([process.env.APP_INTERNAL_URL, "http://app:3000", "http://corner-ops-app:3000", "http://host.docker.internal:3000"].filter(Boolean))];
let appUrl = null;

/** Calls Corner Ops, finding a route to it the first time. */
async function callApp(path, init = {}) {
  const tried = [];
  for (const base of appUrl ? [appUrl] : APP_CANDIDATES) {
    try {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(60_000) });
      appUrl = base;
      return response;
    } catch (error) {
      tried.push(`${base} (${error.cause?.code || error.cause?.message || error.message})`);
    }
  }
  appUrl = null;
  throw new Error(`Couldn't reach Corner Ops from the price job: ${tried.join(", ")}`);
}

/** Waits (up to 3 minutes) for the app, e.g. while it restarts after an update. */
async function waitForApp() {
  const deadline = Date.now() + 3 * 60_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await callApp("/api/health");
      if (response.ok) return;
      last = new Error(`health check answered ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`Corner Ops isn't answering (is the app running? check: curl -fsS http://127.0.0.1:3000/api/health). ${last?.message || ""}`);
}

async function report(supplier, body) {
  let response;
  // An update can recreate the app while the job runs (the deploy timer checks every minute); a dropped
  // connection is retried after the app answers again. Importing the same prices twice only re-saves them
  // (supplier items are upserted and a price change is recorded only when the price differs).
  for (let attempt = 1; ; attempt++) {
    await waitForApp();
    try {
      response = await callApp("/api/cron/supplier-prices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supplier, source: "website", ...body }),
      });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      console.log(`${supplier}: lost the connection to Corner Ops (${error.message.split(": ").pop()}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
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

/**
 * Types a value key by key. Some sign-in pages (US Foods' Microsoft sign-in) show a "facade" box whose script
 * copies each keystroke into the hidden field that is actually submitted; fill() skips those key events.
 */
async function typeInto(field, value) {
  await field.fill("");
  await field.pressSequentially(value, { delay: 35 });
}

async function submit(page, field) {
  // Sign-in pages keep hidden submit buttons for other steps; only press one that is showing.
  const button = page.locator(SUBMIT).filter({ visible: true });
  // Some pages submit by themselves once the value is complete (US Foods' code box), so the field may be gone.
  const enter = async () => { if (await field.isVisible().catch(() => false)) await field.press("Enter", { timeout: 5_000 }).catch(() => {}); };
  if (await visible(button)) await button.first().click().catch(enter);
  else await enter();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
}

// Who each supplier's sign-in emails come from (override with <KEY>_CODE_FROM).
const CODE_FROM = { SYSCO: "sysco", USFOODS: "usfoods", PFG: "pfgc" };

/**
 * Looks in the deli's inbox (IMAP, CODE_EMAIL_* in .env) for the supplier's
 * sign-in email that arrived after `since`, and returns the code in it.
 * Only searches messages from that supplier; nothing else is read or kept.
 */
async function codeFromEmail(supplier, since) {
  const host = process.env.CODE_EMAIL_HOST, user = process.env.CODE_EMAIL_USER;
  // Gmail shows app passwords in groups ("abcd efgh ijkl mnop"); the spaces aren't part of it.
  const pass = /gmail|googlemail/i.test(host || "") ? (process.env.CODE_EMAIL_PASSWORD || "").replace(/\s+/g, "") : process.env.CODE_EMAIL_PASSWORD;
  if (!host || !user || !pass) return null;
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host, port: Number(process.env.CODE_EMAIL_PORT || 993), secure: process.env.CODE_EMAIL_SECURE !== "false", auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(process.env.CODE_EMAIL_FOLDER || "INBOX");
    try {
      const from = process.env[`${supplier.key}_CODE_FROM`] || CODE_FROM[supplier.key] || supplier.name;
      const uids = (await client.search({ since: new Date(since - 86_400_000), from }, { uid: true })) || [];
      let newest = null;
      for await (const message of client.fetch(uids.slice(-10), { source: true, internalDate: true }, { uid: true })) {
        if (!message.internalDate || message.internalDate.getTime() < since) continue;
        const mail = await simpleParser(message.source);
        const code = extractSignInCode(`${mail.subject || ""} ${mail.text || ""} ${typeof mail.html === "string" ? mail.html : ""}`);
        if (code && (!newest || message.internalDate > newest.at)) newest = { code, at: message.internalDate };
      }
      return newest?.code ?? null;
    } finally {
      lock.release();
    }
  } catch (error) {
    console.error(`${supplier.name}: couldn't check email for the code (${error.message})`);
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Gets the sign-in code the supplier just sent: from the deli's inbox when
 * CODE_EMAIL_* is set, or typed into Supplier costs by a manager. Waits up to
 * 10 minutes.
 */
async function waitForCode(supplier) {
  const once = process.env[`${supplier.key}_CODE`];
  if (once) return once;
  // Codes sent a moment before we got to this page still count.
  const since = Date.now() - 2 * 60_000;
  const emailOn = Boolean(process.env.CODE_EMAIL_HOST && process.env.CODE_EMAIL_USER && process.env.CODE_EMAIL_PASSWORD);
  await report(supplier.name, {
    status: "needs_code",
    message: emailOn
      ? `${supplier.name} sent a sign-in code. Checking the email for it; you can also type it in here.`
      : `${supplier.name} sent a sign-in code by email or text. Type it in on Supplier costs within 10 minutes.`,
  }).catch((error) => console.error(error.message));
  console.log(`${supplier.name}: waiting for the sign-in code to be entered on Supplier costs…`);
  const deadline = Date.now() + 10 * 60_000;
  let checks = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    // Email every 15 seconds (it takes a moment to arrive), the app every 5.
    if (emailOn && checks++ % 3 === 0) {
      const code = await codeFromEmail(supplier, since);
      if (code) {
        console.log(`${supplier.name}: found the sign-in code in the email`);
        return code;
      }
    }
    try {
      const response = await callApp(`/api/cron/supplier-prices?code=${encodeURIComponent(supplier.name)}`);
      const body = await response.json();
      if (body.code) return String(body.code);
    } catch {
      // Keep waiting through a brief app restart.
    }
  }
  return null;
}

async function clickText(page, pattern) {
  const target = page.locator("button, a, label, [role=radio], [role=button], input[type=radio] + *").filter({ hasText: pattern });
  if (await visible(target)) {
    await target.first().click().catch(() => {});
    return true;
  }
  return false;
}

/**
 * Signs in if the page is asking. Handles password sites, username-only sites
 * that send a one-time code (US Foods), and "send the code by email or text?"
 * choices (${key}_CODE_VIA=email|text, email by default).
 */
/** A visible "Log In" / "Sign In" button or link: the page is showing a guest. (getByText reaches into the shadow DOM of web-component buttons.) */
function loginPrompt(page) {
  return page.getByText(/^\s*(log ?in|sign ?in)\s*$/i);
}

async function signIn(page, supplier, user, password) {
  let askedForCode = false, choseMethod = false;
  for (let step = 0; step < 8; step++) {
    const passwordField = page.locator(PASSWORD_FIELD), userField = page.locator(USER_FIELD), codeField = page.locator(CODE_FIELD);
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 5_000);
    if (await visible(codeField) && /code|verif|one-time|passcode|authenticat/i.test(bodyText)) {
      if (askedForCode) return { status: "needs_code", message: `${supplier.name} didn't accept the code. Press Sync now and enter the newest code.` };
      askedForCode = true;
      const code = await waitForCode(supplier);
      if (!code) return { status: "needs_code", message: `No sign-in code was entered for ${supplier.name} within 10 minutes. Press Sync now to try again.` };
      await typeInto(codeField.first(), code);
      const remember = page.getByLabel(/remember|trust this|don.t ask|this device/i);
      if (await visible(remember)) await remember.first().check().catch(() => {});
      await submit(page, codeField.first());
      continue;
    }
    // "Would you like to stay signed in on this device?" Yes keeps this browser trusted, so later runs skip the code.
    const staySignedIn = page.getByRole("button", { name: /^\s*yes\s*$/i });
    if (/stay signed in|remember (this|me)|trust this (device|browser)/i.test(bodyText) && (await visible(staySignedIn))) {
      await staySignedIn.first().click().catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(6_000);
      continue;
    }
    // One button per destination, e.g. US Foods' "Text ***-***-3125" / "Email c***@gmail.com" (no wording to match).
    const via = (process.env[`${supplier.key}_CODE_VIA`] || "email").toLowerCase();
    const methodButton = page.getByRole("button", { name: via === "text" ? /^\s*(text|sms)\b/i : /^\s*e-?mail\b/i });
    if (await visible(methodButton)) {
      // Choosing sends a code; if the page doesn't move on, stop rather than send another one.
      if (choseMethod) return { status: "needs_login", message: `${supplier.name} didn't move past choosing where to send the sign-in code.` };
      choseMethod = true;
      await methodButton.first().click();
      await page.waitForTimeout(4_000);
      const send = page.locator(SUBMIT).filter({ visible: true });
      if (!(await visible(page.locator(CODE_FIELD))) && (await visible(send))) {
        await send.first().click().catch(() => {});
        await page.waitForTimeout(4_000);
      }
      continue;
    }
    // "Where should we send your code?" — pick email or text, then send.
    // (Not the username page, which may also say "we'll send you a code".)
    const usernameEmpty = (await visible(userField)) && !(await userField.first().inputValue().catch(() => ""));
    if (!usernameEmpty && /send (you )?(a|the|your)? ?(verification |security |one-time )?code|how would you like|verify (it.s you|your identity)|choose a (method|verification)/i.test(bodyText) && /e-?mail|text|sms|phone/i.test(bodyText)) {
      const via = (process.env[`${supplier.key}_CODE_VIA`] || "email").toLowerCase();
      await clickText(page, via === "text" ? /text|sms|phone/i : /e-?mail/i);
      if (!(await clickText(page, /^\s*(send|continue|next|send code)\s*$/i))) await clickText(page, /send|continue|next/i);
      await page.waitForTimeout(3_000);
      continue;
    }
    if (await visible(passwordField)) {
      if (!password) return { status: "needs_login", message: `${supplier.name} is asking for a password. Add ${supplier.key}_PASSWORD to /opt/corner-ops/.env.` };
      if (await visible(userField) && !(await userField.first().inputValue().catch(() => ""))) await typeInto(userField.first(), user);
      await typeInto(passwordField.first(), password);
      const remember = page.getByLabel(/remember|keep me signed in|stay signed in/i);
      if (await visible(remember)) await remember.first().check().catch(() => {});
      await submit(page, passwordField.first());
      continue;
    }
    if (await visible(userField)) {
      if ((await userField.first().inputValue().catch(() => "")) === user && step > 0) {
        return { status: "needs_login", message: `${supplier.name} didn't move past the username. Check ${supplier.key}_USERNAME in /opt/corner-ops/.env.` };
      }
      await typeInto(userField.first(), user);
      const remember = page.getByLabel(/remember|keep me signed in|stay signed in/i);
      if (await visible(remember)) await remember.first().check().catch(() => {});
      await submit(page, userField.first());
      continue;
    }
    // A guest page (no form, but a "Log In" button): open the sign-in page. US Foods sends guests to
    // its public catalogue, which loads product data but no account prices, so this is not "signed in".
    const prompt = loginPrompt(page);
    if (await visible(prompt)) {
      await prompt.first().click().catch(() => {});
      await page.waitForTimeout(6_000);
      continue;
    }
    return { status: "signed_in" };
  }
  if (await visible(loginPrompt(page)))
    return { status: "needs_login", message: `${supplier.name} still shows its Log In button after signing in, so the job is browsing as a guest. Check ${supplier.key}_LOGIN_URL and ${supplier.key}_USERNAME in /opt/corner-ops/.env.` };
  if (await visible(page.locator(PASSWORD_FIELD)) || await visible(page.locator(USER_FIELD)))
    return { status: "needs_login", message: `${supplier.name} didn't accept the sign-in. Check ${supplier.key}_USERNAME${password ? ` and ${supplier.key}_PASSWORD` : ""} in /opt/corner-ops/.env.` };
  return { status: "signed_in" };
}

/**
 * The shape of a JSON response without its values (field names, list sizes,
 * value types), so the price reader can be tuned to a site without sharing
 * prices or account details.
 */
function describe(json, path = "", depth = 0, out = []) {
  if (depth > 6 || out.length > 400) return out.join("\n");
  if (Array.isArray(json)) {
    out.push(`  ${path || "(root)"}: list of ${json.length}`);
    if (json.length && json[0] && typeof json[0] === "object") describe(json[0], `${path}[0]`, depth + 1, out);
  } else if (json && typeof json === "object") {
    for (const [key, value] of Object.entries(json)) {
      const at = path ? `${path}.${key}` : key;
      if (value && typeof value === "object") describe(value, at, depth + 1, out);
      else out.push(`  ${at}: ${value === null ? "null" : typeof value}${typeof value === "string" && /^\$?\d+(\.\d+)?$/.test(value) ? " (number-like)" : ""}`);
    }
  }
  return out.join("\n");
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
  // Password is optional: US Foods signs in with a username and a one-time code.
  if (!user) {
    console.log(`${supplier.name}: skipped (no ${supplier.key}_USERNAME)`);
    return;
  }
  const loginUrl = process.env[`${supplier.key}_LOGIN_URL`] || supplier.login;
  // One or more list pages (space or comma separated); prices from all of them are combined.
  const guideUrls = (process.env[`${supplier.key}_ORDER_GUIDE_URL`] || supplier.guide).split(/[\s,]+/).filter(Boolean);
  const guideUrl = guideUrls[0] || "";
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
    if (guideUrl) {
      await page.goto(guideUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(6_000);
      console.log(`${supplier.name}: opened ${guideUrl} → ${page.url()}`);
    } else {
      const link = page.locator('a:has-text("Order Guide"), a:has-text("Order guide"), a:has-text("My Lists"), a:has-text("Lists"), button:has-text("Order Guide")');
      if (await visible(link)) await link.first().click();
    }
    await page.waitForTimeout(6_000);
    // Signed in, but the site asked again (session expired mid-way).
    if (await visible(page.locator(PASSWORD_FIELD)) || (/log-?in|sign-?in|auth/i.test(page.url()) && await visible(page.locator(USER_FIELD)))) {
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
    for (const url of guideUrls.slice(1)) {
      console.log(`${supplier.name}: also reading ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => console.log(`${supplier.name}: ${error.message.split("\n")[0]}`));
      await page.waitForTimeout(6_000);
      console.log(`${supplier.name}: landed on ${page.url()}`);
      await loadEverything(page);
    }
    // Products in one response, plus products whose prices come in a separate response (US Foods).
    const found = () => dedupeProducts([...captured.flatMap((c) => extractProducts(c.json)), ...joinSplitProducts(captured.map((c) => c.json))]);
    // The page we opened had no list prices (sites move things): look for the
    // order guide / lists in the site's own menus, then open the first list.
    const visited = new Set([page.url()]);
    for (const pattern of [/^\s*(my )?order guides?\s*$/i, /^\s*(my |shopping )?lists?\s*$/i, /order guide/i, /\blists?\b/i, /favorites|purchase history|frequently (bought|ordered)/i]) {
      if (found().length >= 3) break;
      const link = page.locator("a, button, [role=link], [role=menuitem], [role=tab]").filter({ hasText: pattern });
      if (!(await visible(link))) continue;
      await link.first().click().catch(() => {});
      await page.waitForTimeout(5_000);
      // On a page of lists, open the first one (the order guide is usually first).
      if (found().length < 3) {
        const firstList = page.locator('a[href*="list" i], [role=row] a, li a, [class*="list" i] a').filter({ hasText: /\w{3,}/ });
        if (await visible(firstList)) {
          await firstList.first().click().catch(() => {});
          await page.waitForTimeout(5_000);
        }
      }
      if (visited.has(page.url())) continue;
      visited.add(page.url());
      console.log(`${supplier.name}: trying ${page.url()}`);
      await loadEverything(page);
    }

    const products = found();
    let csv = products.length >= 3 ? productsToCsv(products) : null;
    if (!csv) csv = await tryExport(page, supplier);
    if (!csv) {
      const picture = await shot("no-products");
      // What the page loaded, for tuning: URLs and top-level keys only.
      writeFileSync(`${DEBUG}/${supplier.key}-${stamp}-responses.txt`, captured.map((c) => `${c.url.split("?")[0]}\n${describe(c.json)}`).join("\n\n"));
      // The site's menu links (text and address only), to find the order guide page.
      const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => `${(a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)}\t${a.href}`).filter((l) => !l.startsWith("\t")));
      writeFileSync(`${DEBUG}/${supplier.key}-${stamp}-links.txt`, [...new Set(links)].join("\n"));
      const message = `Signed in, but found no prices (last page ${page.url()}). Open your order guide in a browser and put its address in ${supplier.key}_ORDER_GUIDE_URL. Screenshot and site links: ${picture.replace(DEBUG, "/opt/corner-ops/supplier-prices/_website").replace(/-no-products\.png$/, "-*")}`;
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
try {
  await waitForApp();
} catch (error) {
  console.error(error.message);
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
