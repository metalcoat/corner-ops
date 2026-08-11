#!/usr/bin/env node

/**
 * Development-only discovery utility for Rezku's browser-rendered online menu.
 *
 * It intentionally captures network JSON and rendered DOM instead of guessing
 * Rezku's private API schema. Once we have a real Corner Deli capture, the
 * normalized mapper can be made deterministic and tested before any menu write.
 *
 * Usage:
 *   npm i -D playwright-core
 *   node scripts/rezku-discover-menu.mjs
 *
 * Optional:
 *   REZKU_URL=https://order.rezku.com/cornerdeli/cover
 *   REZKU_BROWSER_CHANNEL=msedge|chrome
 *   REZKU_DISCOVERY_OUT=tmp/rezku-cornerdeli-discovery.json
 */

import fs from "node:fs/promises";
import path from "node:path";

const sourceUrl = process.env.REZKU_URL || "https://order.rezku.com/cornerdeli/cover";
const browserChannel = process.env.REZKU_BROWSER_CHANNEL || "msedge";
const outputPath = process.env.REZKU_DISCOVERY_OUT || "tmp/rezku-cornerdeli-discovery.json";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core is not installed. Run: npm i -D playwright-core");
  process.exit(1);
}

const captured = [];
const browser = await chromium.launch({ channel: browserChannel, headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on("response", async (response) => {
  try {
    const headers = response.headers();
    const contentType = String(headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("json")) return;
    const text = await response.text();
    if (!text || text.length > 10_000_000) return;
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

try {
  await page.goto(sourceUrl, { waitUntil: "networkidle", timeout: 60_000 });

  // Rezku can show a cover/fulfillment screen before the menu. Try the normal
  // guest-facing buttons without depending on fragile CSS class names.
  for (const pattern of [/preview menu/i, /view menu/i, /start order/i]) {
    const button = page.getByRole("button", { name: pattern }).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 5_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
      } catch {
        // The next candidate may still expose the menu.
      }
    }
  }

  const renderedText = await page.locator("body").innerText().catch(() => "");
  const renderedHtml = await page.content();
  const payload = {
    capturedAt: new Date().toISOString(),
    sourceUrl,
    finalUrl: page.url(),
    browserChannel,
    jsonResponses: captured,
    renderedText,
    renderedHtml,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Captured ${captured.length} JSON responses from Rezku.`);
  console.log(`Saved discovery file: ${outputPath}`);
} finally {
  await browser.close();
}
