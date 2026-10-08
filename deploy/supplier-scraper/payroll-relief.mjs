// Payroll Relief job: enters an approved Corner Deli payroll week's hours and tips
// in the owner's payroll website (AccountantsOffice → Payroll Relief) and SAVES
// them. It never submits: the owner reviews the entries there and presses Submit.
//
// Steps: sign in (saved session first, else the account in .env; if AccountantsOffice
// texts a code, the owner types it on Corner Ops' payroll page) → Payroll Relief →
// Payroll Entry → check the open payroll is the approved week → Timesheet Options →
// Download Excel → report Payroll Relief's employees → fill Reg / TipWa / PCTip / OT
// for the matched employees (src/lib/payroll-relief-timesheet.ts) → Upload → check the
// grid's Totals equal the file's → Save → reload and check again → report.
//
// Started by deploy/supplier-prices-sync.sh for each queued submission:
//   docker compose ... run --rm --no-deps -e SUBMISSION_ID=<id> --entrypoint node supplier-prices payroll-relief.mjs
// Dry run (signs in, checks the period, downloads, writes the filled CSV to /debug, then stops;
// no upload, no save, nothing reported to the queue; Payroll Relief's employee list is still
// reported so the matches can be set up):
//   docker compose ... run --rm --no-deps -e DRY_RUN=1 -e PREVIEW_BUSINESS="Corner Deli" -e PREVIEW_WEEK=2026-09-28 \
//     --entrypoint node supplier-prices payroll-relief.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { restoreSessionCookies, saveSessionCookies } from "./session-cookies.mjs";
import {
  FORBIDDEN_CONTROL,
  compareTotals,
  employeeKey,
  formatTotals,
  gridTotals,
  parsePayrollEntryPeriod,
  parseTimesheet,
  periodMismatch,
  planTimesheet,
  timesheetRoster,
  timesheetTotals,
  weekRangeLabel,
} from "./payroll-relief-timesheet.ts";

const SECRET = process.env.CRON_SECRET || "";
const DEBUG = process.env.DEBUG_DIR || "/debug";
const PROFILES = process.env.PROFILE_DIR || "/profiles";
const KEY = "ACCOUNTANTSOFFICE";
const SUBMISSION_ID = (process.env.SUBMISSION_ID || "").trim();
const PREVIEW_BUSINESS = (process.env.PREVIEW_BUSINESS || "").trim();
const PREVIEW_WEEK = (process.env.PREVIEW_WEEK || "").trim();
// A preview has no submission to report to, so it is always a dry run.
const DRY_RUN = process.env.DRY_RUN === "1" || (!SUBMISSION_ID && Boolean(PREVIEW_WEEK));
const CODE_MINUTES = 10;

const LOGIN = "https://login.accountantsoffice.com/login?firmCode=whale1910&returnurl=https://www.accountantsoffice.com/aocommon/account/login";
const HOME = "https://www.accountantsoffice.com/aocommon/";
const LAUNCH = "https://www.accountantsoffice.com/AoCommon/Home/Launch/payroll";
const ENTRY = "https://app.payrollrelief.com/Payroll/PayrollEntry";
const SIGN_IN_BY_HAND = "/opt/corner-ops/runtime/deploy/supplier-prices-sync.sh --signin accountantsoffice";
const HOST_DEBUG = "/opt/corner-ops/supplier-prices/_website";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(DEBUG, { recursive: true });
const log = (message) => console.log(`Payroll Relief: ${message}`);
const hostPath = (path) => path.replace(DEBUG, HOST_DEBUG);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Corner Ops ------------------------------------------------------------

const APP_CANDIDATES = [...new Set([process.env.APP_INTERNAL_URL, "http://app:3000", "http://corner-ops-app:3000", "http://host.docker.internal:3000"].filter(Boolean))];
let appUrl = null;

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
  throw new Error(`Couldn't reach Corner Ops from the payroll job: ${tried.join(", ")}`);
}

async function appJson(path, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await callApp(path, init);
      const text = await response.text();
      let body = {};
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (!response.ok) throw Object.assign(new Error(body.error || `Corner Ops answered ${response.status}: ${text.slice(0, 200)}`), { status: response.status });
      return body;
    } catch (error) {
      // An update may restart the app while the job runs; retry dropped connections, not refusals.
      if (error.status || attempt >= 4) throw error;
      await sleep(10_000);
    }
  }
}

const post = (body) => appJson("/api/cron/payroll-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Status to the queue: never for a dry run (a texted code still needs somewhere to be typed, see waitForCode). */
async function report(status, message, totals = null) {
  log(`${status}: ${message}`);
  if (DRY_RUN || !SUBMISSION_ID) return;
  await post({ id: SUBMISSION_ID, status, message, totals }).catch((error) => console.error(`Couldn't record the result in Corner Ops: ${error.message}`));
}

// --- Browser helpers -------------------------------------------------------

async function startScreen() {
  spawn("Xvfb", [":97", "-screen", "0", "1440x1000x24", "-nolisten", "tcp"], { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < 50 && !existsSync("/tmp/.X11-unix/X97"); i++) await sleep(100);
  process.env.DISPLAY = ":97";
}

async function visible(locator) {
  try {
    return await locator.first().isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

/** Clicks a control after checking its words: anything that submits or approves payroll is refused outright. */
async function safeClick(locator, what) {
  const target = locator.first();
  const words = await target.evaluate((el) => [el.textContent, el.getAttribute("value"), el.getAttribute("aria-label"), el.getAttribute("title"), el.id, el.getAttribute("name")].filter(Boolean).join(" ")).catch(() => "");
  if (FORBIDDEN_CONTROL.test(words.replace(/\s+/g, " "))) throw new Error(`Refused to press "${words.trim().slice(0, 60)}" while looking for ${what}: the job never submits payroll.`);
  await target.click({ timeout: 15_000 });
}

/** A visible button or link whose whole text is exactly this word (e.g. "Save", never "Save & Submit"). */
function exactButton(scope, word) {
  const pattern = new RegExp(`^\\s*${word}\\s*$`, "i");
  return scope.locator("button, a, input[type=button], input[type=submit], [role=button]").filter({ visible: true }).filter({ hasText: pattern })
    .or(scope.locator(`input[type=button][value="${word}" i], input[type=submit][value="${word}" i]`).filter({ visible: true }));
}

async function bodyText(page) {
  return (await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "")).replace(/ /g, " ");
}

async function settle(page, ms = 3_000) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

// --- Sign-in ---------------------------------------------------------------

function signedInText(text) {
  return /Welcome\s+\S+/i.test(text) && /Payroll Relief/i.test(text);
}

/** The code the owner types on Corner Ops' payroll page, polled for 10 minutes. */
async function waitForCode() {
  if (process.env.ACCOUNTANTSOFFICE_CODE) return process.env.ACCOUNTANTSOFFICE_CODE;
  if (!SUBMISSION_ID) return null;
  await post({ id: SUBMISSION_ID, status: "needs_code", message: `AccountantsOffice texted a sign-in code. Type it on the payroll page within ${CODE_MINUTES} minutes.` })
    .catch((error) => console.error(error.message));
  log("waiting for the texted code to be entered on the payroll page…");
  const deadline = Date.now() + CODE_MINUTES * 60_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    try {
      const body = await appJson(`/api/cron/payroll-submissions?code=${encodeURIComponent(SUBMISSION_ID)}`);
      if (body.code) return String(body.code);
    } catch {
      // Keep waiting through a brief app restart.
    }
  }
  return null;
}

/** Ticks every visible "remember this device / don't ask again" box. */
async function rememberDevice(page) {
  const boxes = page.locator('input[type="checkbox"]').filter({ visible: true });
  for (let i = 0; i < Math.min(await boxes.count().catch(() => 0), 5); i++) {
    const box = boxes.nth(i);
    const label = await box.evaluate((el) => {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return `${byFor?.textContent || ""} ${el.closest("label")?.textContent || ""} ${el.parentElement?.textContent || ""} ${el.name || ""} ${el.id || ""}`;
    }).catch(() => "");
    if (/remember|trust|don.?t ask|do not ask|this (device|computer|browser)|skip/i.test(label)) await box.check().catch(() => {});
  }
}

async function signIn(page) {
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 2_000);
  if (signedInText(await bodyText(page))) return { ok: true };
  const user = process.env.ACCOUNTANTSOFFICE_USERNAME, password = process.env.ACCOUNTANTSOFFICE_PASSWORD;
  if (!user || !password) return { ok: false, message: `AccountantsOffice needs signing in and ACCOUNTANTSOFFICE_USERNAME / ACCOUNTANTSOFFICE_PASSWORD aren't in /opt/corner-ops/.env. Or sign in by hand: ${SIGN_IN_BY_HAND}` };
  // Signed out, the portal sends you to the general login page, which asks for the firm code; the firm's own link fills it in.
  if (!/login\.accountantsoffice\.com/i.test(page.url()) || !/firmcode=/i.test(page.url())) {
    await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle(page, 2_000);
  }
  let askedForCode = false, sentCode = false;
  for (let step = 0; step < 8; step++) {
    const text = await bodyText(page);
    if (signedInText(text)) return { ok: true };
    const onLogin = /login\.accountantsoffice\.com/i.test(page.url());
    const userField = page.locator("#UserName").filter({ visible: true });
    const passwordField = page.locator("#Password").filter({ visible: true });
    if (onLogin && (await visible(passwordField))) {
      if (step > 0 && !askedForCode && /invalid|incorrect|not valid|failed|locked/i.test(text)) return { ok: false, message: "AccountantsOffice didn't accept the username and password in /opt/corner-ops/.env." };
      const firmField = page.locator("#FirmCode").filter({ visible: true });
      if (await visible(firmField) && !(await firmField.first().inputValue().catch(() => ""))) await firmField.first().fill(process.env.ACCOUNTANTSOFFICE_FIRM_CODE || "whale1910");
      if (await visible(userField)) await userField.first().fill(user);
      await passwordField.first().fill(password);
      await rememberDevice(page);
      const button = exactButton(page, "Log in");
      if (await visible(button)) await button.first().click();
      else await passwordField.first().press("Enter");
      await settle(page, 4_000);
      continue;
    }
    // Second screen: a code texted to the owner. Selectors unknown, so: a visible text/number box (not the username).
    const codeField = page.locator('input[autocomplete="one-time-code"], input[type="tel"], input[type="number"], input[type="text"], input:not([type])')
      .filter({ visible: true }).and(page.locator(":not(#UserName)"));
    if (onLogin && (await visible(codeField)) && /code|verif|text|sms|authenticat|security/i.test(text)) {
      if (askedForCode) return { ok: false, message: "AccountantsOffice didn't accept the texted code. Press Send again on the payroll page and enter the newest code." };
      askedForCode = true;
      const code = await waitForCode();
      if (!code) {
        return { ok: false, message: SUBMISSION_ID
          ? `No sign-in code was entered within ${CODE_MINUTES} minutes. Press Send again on the payroll page, then type the code from the text.`
          : `AccountantsOffice wants a texted code. Sign in by hand first (${SIGN_IN_BY_HAND}), then run the dry run again.` };
      }
      await codeField.first().fill(code);
      await rememberDevice(page);
      const button = page.locator('button, input[type="submit"], input[type="button"]').filter({ visible: true })
        .filter({ hasText: /^\s*(verify|submit|continue|next|log ?in|sign ?in|confirm)\s*$/i })
        .or(page.locator('input[type="submit"]').filter({ visible: true }));
      // This is AccountantsOffice's sign-in page (checked above), so its own Submit/Verify button is fine here.
      if (await visible(button)) await button.first().click();
      else await codeField.first().press("Enter");
      await settle(page, 5_000);
      continue;
    }
    // "Send the code by text?" before the code box.
    const send = page.locator("button, a, input[type=submit], input[type=button]").filter({ visible: true }).filter({ hasText: /send (me )?(a |the )?code|text me|send code/i });
    if (onLogin && !sentCode && (await visible(send))) {
      sentCode = true;
      await send.first().click().catch(() => {});
      await settle(page, 4_000);
      continue;
    }
    if (!onLogin) {
      await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await settle(page, 2_000);
      if (signedInText(await bodyText(page))) return { ok: true };
      if (!/login\.accountantsoffice\.com/i.test(page.url())) return { ok: false, message: `After signing in AccountantsOffice showed ${page.url().split("?")[0]} instead of its home page.` };
      continue;
    }
    await settle(page, 3_000);
  }
  return { ok: false, message: `Couldn't get past AccountantsOffice's sign-in (last page ${page.url().split("?")[0]}).` };
}

// --- Payroll Relief --------------------------------------------------------

/** AccountantsOffice → Payroll Relief (same tab, or the tab the link opens). */
async function openPayrollRelief(context, page) {
  await page.goto(LAUNCH, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await settle(page, 3_000);
  if (/payrollrelief\.com/i.test(page.url())) return page;
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 2_000);
  const link = page.locator("a").filter({ hasText: /Payroll Relief/i }).filter({ visible: true });
  if (!(await visible(link))) throw new Error("AccountantsOffice's home page has no Payroll Relief link.");
  const opened = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await link.first().click();
  const tab = (await opened) || page;
  await settle(tab, 4_000);
  if (!/payrollrelief\.com/i.test(tab.url())) throw new Error(`The Payroll Relief link opened ${tab.url().split("?")[0]}.`);
  return tab;
}

async function openPayrollEntry(page) {
  await page.goto(ENTRY, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 4_000);
  await page.getByText(/for\s+Period/i).first().waitFor({ timeout: 30_000 }).catch(() => {});
  return bodyText(page);
}

/** Header cells of the payroll entry grid and its Totals row (with colspans), wherever the grid draws them. */
async function readGrid(page) {
  return page.evaluate(() => {
    const cells = (row) => [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName)).map((c) => ({ text: (c.innerText || c.textContent || "").trim(), span: Number(c.getAttribute("colspan") || 1) }));
    const rows = [...document.querySelectorAll("tr")].filter((r) => r.offsetParent !== null || r.getClientRects().length);
    const header = rows.find((r) => {
      const t = cells(r).map((c) => c.text).join("|");
      return /Reg\s*Hrs/i.test(t) && /PC\s*Tip/i.test(t);
    });
    const totals = [...rows].reverse().find((r) => {
      const first = cells(r).find((c) => c.text);
      return first && /^totals?:?$/i.test(first.text);
    });
    return { header: header ? cells(header) : null, totals: totals ? cells(totals) : null };
  });
}

async function gridTotalsOrThrow(page, when) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const grid = await readGrid(page);
    const totals = grid.header && grid.totals ? gridTotals(grid.header, grid.totals) : null;
    if (totals) return totals;
    if (attempt === 4) {
      writeFileSync(`${DEBUG}/payroll-relief-${stamp}-grid-${when}.json`, JSON.stringify(grid, null, 2));
      throw new Error(`Couldn't read the Totals row of Payroll Relief's payroll entry grid ${when} (see ${hostPath(`${DEBUG}/payroll-relief-${stamp}-grid-${when}.json`)}).`);
    }
    await page.waitForTimeout(3_000);
  }
}

/** A visible error dialog or message after an upload or save. */
async function pageError(page) {
  const messages = page.locator('[role="alert"], [role="dialog"], .k-window, .modal, .ui-dialog, .error, .validation-summary-errors, .alert-danger, .toast-error, .k-notification-error').filter({ visible: true });
  const count = Math.min(await messages.count().catch(() => 0), 6);
  for (let i = 0; i < count; i++) {
    const text = (await messages.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/error|invalid|failed|could not|unable|not found|does not match|mismatch/i.test(text)) return text.slice(0, 300);
  }
  return null;
}

// --- The job ---------------------------------------------------------------

async function loadJob() {
  if (SUBMISSION_ID) return (await appJson(`/api/cron/payroll-submissions?submission=${encodeURIComponent(SUBMISSION_ID)}`)).submission;
  if (PREVIEW_WEEK) {
    return (await appJson(`/api/cron/payroll-submissions?preview=1&business=${encodeURIComponent(PREVIEW_BUSINESS || "Corner Deli")}&weekStart=${encodeURIComponent(PREVIEW_WEEK)}`)).submission;
  }
  throw new Error("Set SUBMISSION_ID (a queued submission), or PREVIEW_WEEK=YYYY-MM-DD (with DRY_RUN=1) for a dry run.");
}

async function run() {
  const job = await loadJob();
  if (!job) throw new Error("No such submission.");
  log(`${job.kind === "roster" ? "checking AccountantsOffice's employee list" : `${job.business} week ${job.weekStart} (payroll v${job.version}, ${job.runStatus})`}${DRY_RUN ? " — DRY RUN, nothing is uploaded or saved" : ""}`);
  if (job.business !== "Corner Deli") return report("failed", "The Docks isn't sent to AccountantsOffice automatically.");
  if (SUBMISSION_ID && !["submitting", "needs_code"].includes(job.status) && !DRY_RUN) {
    throw new Error(`Submission ${SUBMISSION_ID} is ${job.status}, not being sent; nothing done.`);
  }
  if (job.kind === "payroll" && !job.weekStart) throw new Error("The submission has no payroll week.");
  const mapping = Object.fromEntries((job.mapping || []).map((m) => [m.key || employeeKey(m.employee), String(m.eeNum)]));

  if (!process.env.DISPLAY) await startScreen();
  const context = await chromium.launchPersistentContext(`${PROFILES}/${KEY}`, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    locale: "en-US",
    timezoneId: "America/New_York",
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  let page = context.pages()[0] || (await context.newPage());
  let signedIn = false;
  const shot = async (why) => {
    const path = `${DEBUG}/payroll-relief-${stamp}-${why}.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    return hostPath(path);
  };
  try {
    await restoreSessionCookies(context, PROFILES, KEY);
    const login = await signIn(page);
    if (!login.ok) {
      await shot("signin");
      return await report("failed", login.message);
    }
    signedIn = true;
    log("signed in to AccountantsOffice");
    page = await openPayrollRelief(context, page);
    let text = await openPayrollEntry(page);
    if (!/Corner Deli/i.test(text)) {
      throw new Error(`Payroll Relief opened an employer other than Mike's Corner Deli (screenshot ${await shot("employer")}).`);
    }
    const open = parsePayrollEntryPeriod(text);
    log(`open payroll: ${open ? `${open.start} to ${open.end}, pay date ${open.payDate}` : "none found"}`);
    if (job.kind === "payroll") {
      const wrong = periodMismatch(open, job.weekStart);
      if (wrong) {
        const picture = await shot("period");
        return await report("failed", `${wrong} Nothing was entered. (Screenshot ${picture})`);
      }
    }

    // Timesheet Options → Download Excel (a CSV of the payroll's current entries).
    const options = page.locator("a, button, span, [role=button]").filter({ hasText: /^\s*Timesheet Options\s*$/i }).filter({ visible: true });
    if (!(await visible(options))) throw new Error(`Payroll Entry has no Timesheet Options link (screenshot ${await shot("no-options")}). Is the Payroll Submission Method still Excel Timesheet?`);
    await safeClick(options, "Timesheet Options");
    await page.waitForTimeout(1_500);
    const downloadLink = page.locator("a, button, li, span, [role=menuitem]").filter({ hasText: /^\s*Download Excel\s*$/i }).filter({ visible: true });
    if (!(await visible(downloadLink))) throw new Error(`The Timesheet Options menu has no Download Excel (screenshot ${await shot("no-download")}).`);
    const waiting = page.waitForEvent("download", { timeout: 60_000 });
    await safeClick(downloadLink, "Download Excel");
    const download = await waiting;
    const fileName = download.suggestedFilename() || `timesheet-${stamp}.csv`;
    const downloaded = `${DEBUG}/payroll-relief-${stamp}-downloaded-${fileName.replace(/[^\w. -]+/g, "_")}`;
    await download.saveAs(downloaded);
    const sheet = parseTimesheet(readFileSync(downloaded, "utf8"));
    log(`downloaded ${fileName}: ${sheet.employees.length} employees, period ${sheet.periodStart} to ${sheet.periodEnd}, ${sheet.employer}`);

    // Payroll Relief's employees, for matching on the payroll page.
    await post({ roster: timesheetRoster(sheet) }).then((r) => log(`reported ${r.saved} Payroll Relief employees`)).catch((error) => console.error(`Couldn't report the employee list: ${error.message}`));
    if (job.kind === "roster") {
      return await report("submitted", `Found ${sheet.employees.length} employees in Payroll Relief (open payroll ${open ? weekRangeLabel(open.start) : "none"}).`);
    }
    if (!/Corner Deli/i.test(sheet.employer)) throw new Error(`The downloaded timesheet is for "${sheet.employer}", not Mike's Corner Deli.`);
    const fileWrong = periodMismatch({ start: sheet.periodStart, end: sheet.periodEnd }, job.weekStart);
    if (fileWrong) throw new Error(`The downloaded timesheet: ${fileWrong}`);

    const plan = planTimesheet(sheet, job.rows || [], mapping);
    const filledDir = `/tmp/payroll-relief-${stamp}`;
    mkdirSync(filledDir, { recursive: true });
    const uploadPath = `${filledDir}/${fileName}`;
    const filledCopy = `${DEBUG}/payroll-relief-${stamp}-filled-${fileName.replace(/[^\w. -]+/g, "_")}`;
    writeFileSync(uploadPath, plan.text);
    writeFileSync(filledCopy, plan.text);
    for (const entry of plan.entries) log(`  EE #${entry.num} ${entry.rosterName} ← ${entry.employees.join(" + ")}: ${formatTotals(entry.amounts)}`);
    for (const cleared of plan.cleared) log(`  EE #${cleared.num} ${cleared.rosterName}: cleared (had ${formatTotals(cleared.before)}; nothing in Corner Ops this week)`);
    for (const note of plan.notes) log(`  note: ${note}`);
    for (const problem of plan.problems) log(`  PROBLEM: ${problem}`);
    log(`filled timesheet ${hostPath(filledCopy)}: ${formatTotals(plan.totals)}`);
    if (DRY_RUN) {
      log(`DRY RUN: stopping before Upload. ${plan.problems.length ? `${plan.problems.length} problem(s) would stop a real run.` : "A real run would upload and save this file."}`);
      return;
    }
    if (plan.problems.length) return await report("failed", `${plan.problems.join(" ")} Nothing was entered.`);

    // Upload → OK.
    const upload = exactButton(page, "Upload");
    if (!(await visible(upload))) throw new Error(`Payroll Entry has no Upload button (screenshot ${await shot("no-upload")}).`);
    await safeClick(upload, "Upload");
    const fileInput = page.locator('input[type="file"][name="files[]"], input[type="file"]');
    await fileInput.first().waitFor({ state: "attached", timeout: 20_000 });
    await fileInput.first().setInputFiles(uploadPath);
    await page.waitForTimeout(3_000);
    const dialog = page.locator('[role="dialog"], .k-window, .modal, .ui-dialog').filter({ visible: true }).filter({ hasText: /Upload Template/i });
    const ok = exactButton((await visible(dialog)) ? dialog.first() : page, "OK");
    if (!(await visible(ok))) throw new Error(`The Upload dialog has no OK button (screenshot ${await shot("no-ok")}).`);
    await safeClick(ok, "OK");
    await settle(page, 6_000);
    const uploadError = await pageError(page);
    if (uploadError) throw new Error(`Payroll Relief didn't take the upload: ${uploadError} (screenshot ${await shot("upload-error")}). Nothing was saved.`);
    await shot("uploaded");

    const afterUpload = await gridTotalsOrThrow(page, "after-upload");
    const differences = compareTotals(plan.totals, afterUpload);
    if (differences.length) {
      const picture = await shot("totals-mismatch");
      return await report("failed", `After the upload Payroll Relief's totals didn't match the file (${differences.join("; ")}), so it was not saved. Check Payroll Relief's entries before submitting. Screenshot ${picture}`);
    }
    log(`grid totals match after upload: ${formatTotals(afterUpload)}`);

    // Save (only the button reading exactly "Save"; never Submit).
    const save = exactButton(page, "Save");
    if (!(await visible(save))) throw new Error(`Payroll Entry has no Save button (screenshot ${await shot("no-save")}). Nothing was saved.`);
    await safeClick(save, "Save");
    await settle(page, 6_000);
    const saveError = await pageError(page);
    if (saveError) throw new Error(`Payroll Relief didn't save: ${saveError} (screenshot ${await shot("save-error")}).`);
    await shot("saved");

    // Reload: the saved entries must still show the same totals.
    text = await openPayrollEntry(page);
    const reopened = parsePayrollEntryPeriod(text);
    const stillSame = periodMismatch(reopened, job.weekStart);
    const afterSave = await gridTotalsOrThrow(page, "after-save");
    const saved = compareTotals(plan.totals, afterSave);
    const picture = await shot("reloaded");
    if (stillSame || saved.length) {
      return await report("failed", `Saved, but after reloading Payroll Relief ${stillSame || `the totals differ (${saved.join("; ")})`}. Check its entries before submitting. Screenshot ${picture}`, afterSave);
    }
    const extra = [...plan.notes, ...plan.cleared.map((c) => `EE #${c.num} ${c.rosterName} cleared (nothing in Corner Ops this week).`)].join(" ");
    await report("submitted", `${formatTotals(afterSave)}.${extra ? ` ${extra}` : ""}`.slice(0, 990), afterSave);
  } catch (error) {
    const picture = await shot("error");
    await report("failed", `${String(error.message || error).split("\n")[0]} (screenshot ${picture})`);
    process.exitCode = 1;
  } finally {
    if (signedIn) await saveSessionCookies(context, PROFILES, KEY).catch(() => {});
    await context.close().catch(() => {});
  }
}

if (!SECRET) {
  console.error("CRON_SECRET is missing; the payroll job can't reach Corner Ops.");
  process.exit(1);
}
try {
  await run();
} catch (error) {
  console.error(`Payroll Relief: ${error.message}`);
  await report("failed", String(error.message || error).split("\n")[0]);
  process.exitCode = 1;
}
