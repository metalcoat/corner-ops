#!/usr/bin/env node

/**
 * Development-only discovery utility for Rezku's browser-rendered online menu.
 *
 * It intentionally captures network JSON and rendered DOM instead of guessing
 * Rezku's private API schema. Once we have a real Corner Deli capture, the
 * normalized mapper can be made deterministic and tested before any menu write.
 *
 * Usage:
 *   npm i --no-save playwright
 *   REZKU_BROWSER_CHANNEL=bundled node scripts/rezku-discover-menu.mjs
 *
 * Optional:
 *   REZKU_URL=https://order.rezku.com/cornerdeli/cover
 *   REZKU_BROWSER_CHANNEL=bundled|msedge|chrome
 *   REZKU_DISCOVERY_OUT=tmp/rezku-cornerdeli-discovery.json
 */

import fs from "node:fs/promises";
import path from "node:path";

const sourceUrl = process.env.REZKU_URL || "https://order.rezku.com/cornerdeli/cover";
const browserChannel = process.env.REZKU_BROWSER_CHANNEL || "bundled";
const outputPath = process.env.REZKU_DISCOVERY_OUT || "tmp/rezku-cornerdeli-discovery.json";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright is not installed. Run: npm i --no-save playwright");
    process.exit(1);
  }
}

const captured = [];
const launchOptions = { headless: true };
if (browserChannel && browserChannel !== "bundled") launchOptions.channel = browserChannel;
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  locale: "en-US",
});
const page = await context.newPage();

page.on("response", async (response) => {
  try {
    const headers = response.headers();
    const contentType = String(headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("json")) return;
    const text = await response.text();
    if (!text || text.length > 20_000_000) return;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    captured.push({
      url: response.url(),
      status: response.status(),
      contentType,
      body,
    });
  } catch {
    // A navigation can invalidate a response body. Discovery continues.
  }
});

async function clickFirstMatching(patterns) {
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 5_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
        return true;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return false;
}

try {
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  // Rezku can show a cover/fulfillment screen before the menu. Try normal
  // guest-facing actions without depending on fragile CSS class names.
  await clickFirstMatching([/preview menu/i, /view menu/i, /start order/i, /order now/i]);

  // If Rezku asks for pickup/delivery before exposing the menu, prefer pickup
  // for discovery because it usually avoids address validation.
  await clickFirstMatching([/pickup/i, /carryout/i, /takeout/i]);
  await clickFirstMatching([/continue/i, /next/i, /view menu/i, /start order/i]);

  await page.waitForTimeout(2_000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  const renderedText = await page.locator("body").innerText().catch(() => "");
  const renderedHtml = await page.content();
  const payload = {
    capturedAt: new Date().toISOString(),
    sourceUrl,
    finalUrl: page.url(),
    browserChannel,
    title: await page.title().catch(() => ""),
    jsonResponses: captured,
    renderedText,
    renderedHtml,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Captured ${captured.length} JSON responses from Rezku.`);
  console.log(`Final URL: ${payload.finalUrl}`);
  console.log(`Rendered text chars: ${renderedText.length}`);
  console.log(`Saved discovery file: ${outputPath}`);
} finally {
  await browser.close();
}
