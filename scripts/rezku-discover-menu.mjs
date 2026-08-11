#!/usr/bin/env node

/**
 * Development-only discovery utility for Rezku's browser-rendered online menu.
 *
 * It captures the rendered menu, Rezku's menu tree, and every product detail
 * payload so the migration can preserve variants, modifier groups, defaults,
 * per-variant modifier pricing, and online availability without guessing.
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: "en-US" });
const page = await context.newPage();

page.on("response", async (response) => {
  try {
    const headers = response.headers();
    const contentType = String(headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("json")) return;
    const text = await response.text();
    if (!text || text.length > 20_000_000) return;
    let body;
    try { body = JSON.parse(text); } catch { return; }
    captured.push({ url: response.url(), status: response.status(), contentType, body });
  } catch {
    // Navigations can invalidate an in-flight response body. Discovery continues.
  }
});

async function clickFirstMatching(patterns) {
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).first();
    if (!(await button.count())) continue;
    try {
      await button.click({ timeout: 5_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      return true;
    } catch {
      // Try next candidate.
    }
  }
  return false;
}

function collectProductNodes(nodes, result = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node && (node.type === "product" || node.type === "pizza") && Number.isInteger(node.id)) {
      result.push({ id: node.id, name: String(node.name || ""), type: node.type });
    }
    if (Array.isArray(node?.children)) collectProductNodes(node.children, result);
  }
  return result;
}

async function captureEveryProductDetail() {
  const menuResponse = captured.find((entry) => entry.url.includes("/online-ordering/menu-tree"));
  const menuUrl = menuResponse?.url || "";
  const restaurantMatch = menuUrl.match(/\/r\/([^/]+)\/online-ordering\/menu-tree/);
  const products = collectProductNodes(menuResponse?.body?.products || []);
  if (!restaurantMatch || !products.length) return { productsFound: products.length, productDetailsCaptured: 0 };

  const restaurantId = restaurantMatch[1];
  let productDetailsCaptured = 0;
  for (const product of products) {
    const url = `https://api.order.rezku.com/r/${restaurantId}/online-ordering/product?id=${product.id}&v2=`;
    try {
      const response = await context.request.get(url, { timeout: 20_000 });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (body) {
        captured.push({
          url,
          status: response.status(),
          contentType: String(response.headers()["content-type"] || ""),
          body,
          discoveryProduct: product,
        });
        productDetailsCaptured += 1;
      }
    } catch (error) {
      captured.push({ url, status: 0, contentType: "", body: null, discoveryProduct: product, discoveryError: String(error) });
    }
  }
  return { productsFound: products.length, productDetailsCaptured };
}

try {
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  await clickFirstMatching([/preview menu/i, /view menu/i, /start order/i, /order now/i]);
  await clickFirstMatching([/pickup/i, /carryout/i, /takeout/i]);
  await clickFirstMatching([/continue/i, /next/i, /view menu/i, /start order/i]);
  await page.waitForTimeout(2_000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  const renderedText = await page.locator("body").innerText().catch(() => "");
  const renderedHtml = await page.content();
  const productCapture = await captureEveryProductDetail();

  const payload = {
    capturedAt: new Date().toISOString(),
    sourceUrl,
    finalUrl: page.url(),
    browserChannel,
    title: await page.title().catch(() => ""),
    productCapture,
    jsonResponses: captured,
    renderedText,
    renderedHtml,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Captured ${captured.length} JSON responses from Rezku.`);
  console.log(`Product details: ${productCapture.productDetailsCaptured}/${productCapture.productsFound}.`);
  console.log(`Final URL: ${payload.finalUrl}`);
  console.log(`Rendered text chars: ${renderedText.length}`);
  console.log(`Saved discovery file: ${outputPath}`);
} finally {
  await browser.close();
}
