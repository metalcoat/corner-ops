import { squareMoneyToDollars } from "@/lib/square-money";
import { createHmac } from "node:crypto";
import { ensureIntegrationSchema } from "@/lib/integrations";
import { getSql } from "@/lib/db";
import { decryptIntegrationSecret as decryptSecret, encryptIntegrationSecret as encryptSecret } from "@/lib/integration-crypto";
import { createOAuthState } from "@/lib/oauth-state";
import { constantTimeEqual } from "@/lib/security-keys";

const SQUARE_VERSION = process.env.SQUARE_API_VERSION?.trim() || "2026-07-15";

type ConnectionRow = {
  id: string;
  external_item_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  token_expires_at: string | null;
  metadata: Record<string, unknown>;
};

type SquareMoney = { amount?: number | string; currency?: string } | null | undefined;
type SquareObject = Record<string, unknown>;

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}


function squareEnvironment(): "sandbox" | "production" {
  return process.env.SQUARE_ENV?.toLowerCase() === "production" ? "production" : "sandbox";
}

function squareBase(): string {
  return squareEnvironment() === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
}


function allowedOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("Square callback requires HTTPS.");
  return url.origin;
}


async function squareRequest<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${squareBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const errors = Array.isArray(payload.errors) ? payload.errors as Array<Record<string, unknown>> : [];
    throw new Error(clean(errors[0]?.detail || errors[0]?.code || `Square request failed (${response.status}).`, 500));
  }
  return payload as T;
}

export async function ensureSquareControlSchema(): Promise<void> {
  await ensureIntegrationSchema();
  const sql = getSql();




}

async function activeConnection(merchantId?: string): Promise<ConnectionRow | null> {
  const rows = merchantId
    ? await getSql()`
        SELECT id, external_item_id, encrypted_access_token, encrypted_refresh_token, token_expires_at, metadata
        FROM integration_connections
        WHERE provider = 'Square' AND status = 'Active' AND external_item_id = ${merchantId}
        ORDER BY updated_at DESC LIMIT 1
      `
    : await getSql()`
        SELECT id, external_item_id, encrypted_access_token, encrypted_refresh_token, token_expires_at, metadata
        FROM integration_connections
        WHERE provider = 'Square' AND status = 'Active'
        ORDER BY updated_at DESC LIMIT 1
      `;
  return ((rows as unknown as ConnectionRow[])[0] || null);
}

async function activeToken(connection: ConnectionRow): Promise<string> {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now() + 24 * 60 * 60 * 1000) return decryptSecret(connection.encrypted_access_token);
  const refreshToken = decryptSecret(connection.encrypted_refresh_token);
  const clientId = process.env.SQUARE_APPLICATION_ID?.trim();
  const clientSecret = process.env.SQUARE_APPLICATION_SECRET?.trim();
  if (!refreshToken || !clientId || !clientSecret) throw new Error("Square refresh credentials are unavailable.");
  const response = await fetch(`${squareBase()}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    cache: "no-store",
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(clean(payload.message || payload.error_description || "Square token refresh failed.", 500));
  const accessToken = clean(payload.access_token, 5000);
  const nextRefresh = clean(payload.refresh_token || refreshToken, 5000);
  await getSql()`
    UPDATE integration_connections SET encrypted_access_token = ${encryptSecret(accessToken)},
      encrypted_refresh_token = ${encryptSecret(nextRefresh)},
      token_expires_at = ${payload.expires_at ? String(payload.expires_at) : null}, updated_at = NOW()
    WHERE id = ${connection.id}
  `;
  return accessToken;
}

export async function squareFullAuthorizationUrl(origin: string): Promise<string> {
  const applicationId = process.env.SQUARE_APPLICATION_ID?.trim();
  if (!applicationId || !process.env.SQUARE_APPLICATION_SECRET?.trim()) throw new Error("Square is not configured.");
  const safeOrigin = allowedOrigin(origin);
  const redirectUri = `${safeOrigin}/api/square/callback`;
  const state = await createOAuthState({ origin: safeOrigin, redirectUri, business: "Tiki", expiresAt: Date.now() + 10 * 60_000 });
  const url = new URL(`${squareBase()}/oauth2/authorize`);
  url.searchParams.set("client_id", applicationId);
  url.searchParams.set("scope", "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ ITEMS_READ INVENTORY_READ");
  url.searchParams.set("session", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

async function upsertPayment(connectionId: string, payment: SquareObject): Promise<void> {
  const paymentId = clean(payment.id, 150);
  if (!paymentId || !payment.created_at) return;
  await getSql()`
    INSERT INTO square_payments (
      id, connection_id, external_payment_id, order_id, location_id, created_at_square,
      updated_at_square, amount, tip_amount, status, raw
    ) VALUES (
      ${crypto.randomUUID()}, ${connectionId}, ${paymentId}, ${clean(payment.order_id, 150)},
      ${clean(payment.location_id, 150)}, ${String(payment.created_at)},
      ${payment.updated_at ? String(payment.updated_at) : null}, ${squareMoneyToDollars(payment.amount_money as SquareMoney)},
      ${squareMoneyToDollars(payment.tip_money as SquareMoney)}, ${clean(payment.status, 50)}, ${JSON.stringify(payment)}::jsonb
    )
    ON CONFLICT (external_payment_id) DO UPDATE SET order_id = EXCLUDED.order_id,
      location_id = EXCLUDED.location_id, updated_at_square = EXCLUDED.updated_at_square,
      amount = EXCLUDED.amount, tip_amount = EXCLUDED.tip_amount, status = EXCLUDED.status,
      raw = EXCLUDED.raw, updated_at = NOW()
  `;
}

async function upsertOrder(connectionId: string, order: SquareObject): Promise<void> {
  const externalOrderId = clean(order.id, 150);
  if (!externalOrderId) return;
  const source = (order.source || {}) as SquareObject;
  const rows = await getSql()`
    INSERT INTO square_orders (
      id, connection_id, external_order_id, location_id, state, source_name,
      created_at_square, updated_at_square, closed_at_square, total_amount, tax_total, tip_total, raw
    ) VALUES (
      ${crypto.randomUUID()}, ${connectionId}, ${externalOrderId}, ${clean(order.location_id, 150)},
      ${clean(order.state, 50)}, ${clean(source.name, 120)}, ${order.created_at ? String(order.created_at) : null},
      ${order.updated_at ? String(order.updated_at) : null}, ${order.closed_at ? String(order.closed_at) : null},
      ${squareMoneyToDollars(order.total_money as SquareMoney)}, ${squareMoneyToDollars(order.total_tax_money as SquareMoney)},
      ${squareMoneyToDollars(order.total_tip_money as SquareMoney)}, ${JSON.stringify(order)}::jsonb
    )
    ON CONFLICT (external_order_id) DO UPDATE SET location_id = EXCLUDED.location_id,
      state = EXCLUDED.state, source_name = EXCLUDED.source_name,
      created_at_square = EXCLUDED.created_at_square, updated_at_square = EXCLUDED.updated_at_square,
      closed_at_square = EXCLUDED.closed_at_square, total_amount = EXCLUDED.total_amount,
      tax_total = EXCLUDED.tax_total, tip_total = EXCLUDED.tip_total, raw = EXCLUDED.raw, updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  const orderId = rows[0].id;
  const lines = Array.isArray(order.line_items) ? order.line_items as SquareObject[] : [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const externalLineId = clean(line.uid || `${externalOrderId}:${index}`, 180);
    const modifiers = Array.isArray(line.modifiers) ? line.modifiers : [];
    await getSql()`
      INSERT INTO square_order_lines (
        id, square_order_id, external_line_id, catalog_object_id, item_name, variation_name,
        quantity, gross_sales, total_tax, total_discount, total_money, modifiers, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${orderId}, ${externalLineId}, ${clean(line.catalog_object_id, 180)},
        ${clean(line.name, 240)}, ${clean(line.variation_name, 240)}, ${numberValue(line.quantity)},
        ${squareMoneyToDollars(line.gross_sales_money as SquareMoney)}, ${squareMoneyToDollars(line.total_tax_money as SquareMoney)},
        ${squareMoneyToDollars(line.total_discount_money as SquareMoney)}, ${squareMoneyToDollars(line.total_money as SquareMoney)},
        ${JSON.stringify(modifiers)}::jsonb, ${JSON.stringify(line)}::jsonb
      )
      ON CONFLICT (square_order_id, external_line_id) DO UPDATE SET catalog_object_id = EXCLUDED.catalog_object_id,
        item_name = EXCLUDED.item_name, variation_name = EXCLUDED.variation_name,
        quantity = EXCLUDED.quantity, gross_sales = EXCLUDED.gross_sales,
        total_tax = EXCLUDED.total_tax, total_discount = EXCLUDED.total_discount,
        total_money = EXCLUDED.total_money, modifiers = EXCLUDED.modifiers, raw = EXCLUDED.raw
    `;
  }
}

function catalogDetails(object: SquareObject) {
  const type = clean(object.type, 50);
  const itemData = (object.item_data || {}) as SquareObject;
  const variationData = (object.item_variation_data || {}) as SquareObject;
  const categoryData = (object.category_data || {}) as SquareObject;
  const modifierData = (object.modifier_data || {}) as SquareObject;
  const modifierListData = (object.modifier_list_data || {}) as SquareObject;
  const name = clean(itemData.name || variationData.name || categoryData.name || modifierData.name || modifierListData.name, 240);
  return {
    type,
    name,
    parentCatalogId: clean(object.is_deleted ? "" : itemData.category_id || (categoryData.parent_category as SquareObject | undefined)?.id, 180),
    variationOfId: clean(variationData.item_id, 180),
    sku: clean(variationData.sku, 120),
    price: squareMoneyToDollars(variationData.price_money as SquareMoney),
    active: !Boolean(object.is_deleted) && variationData.available_for_booking !== false,
  };
}

async function upsertCatalog(connectionId: string, object: SquareObject): Promise<void> {
  const externalObjectId = clean(object.id, 180);
  if (!externalObjectId) return;
  const details = catalogDetails(object);
  await getSql()`
    INSERT INTO square_catalog_objects (
      id, connection_id, external_object_id, object_type, name, parent_catalog_id,
      variation_of_id, sku, price, active, updated_at_square, version, raw
    ) VALUES (
      ${crypto.randomUUID()}, ${connectionId}, ${externalObjectId}, ${details.type}, ${details.name},
      ${details.parentCatalogId}, ${details.variationOfId}, ${details.sku}, ${details.price}, ${details.active},
      ${object.updated_at ? String(object.updated_at) : null}, ${object.version ? numberValue(object.version) : null},
      ${JSON.stringify(object)}::jsonb
    )
    ON CONFLICT (external_object_id) DO UPDATE SET object_type = EXCLUDED.object_type,
      name = EXCLUDED.name, parent_catalog_id = EXCLUDED.parent_catalog_id,
      variation_of_id = EXCLUDED.variation_of_id, sku = EXCLUDED.sku,
      price = EXCLUDED.price, active = EXCLUDED.active,
      updated_at_square = EXCLUDED.updated_at_square, version = EXCLUDED.version,
      raw = EXCLUDED.raw, updated_at = NOW()
  `;
}

async function upsertInventory(connectionId: string, count: SquareObject): Promise<void> {
  const catalogObjectId = clean(count.catalog_object_id, 180);
  const locationId = clean(count.location_id, 180);
  const state = clean(count.state || "IN_STOCK", 80);
  if (!catalogObjectId || !locationId) return;
  await getSql()`
    INSERT INTO square_inventory_counts (
      id, connection_id, catalog_object_id, location_id, state, quantity, calculated_at
    ) VALUES (
      ${crypto.randomUUID()}, ${connectionId}, ${catalogObjectId}, ${locationId}, ${state},
      ${numberValue(count.quantity)}, ${count.calculated_at ? String(count.calculated_at) : null}
    )
    ON CONFLICT (catalog_object_id, location_id, state) DO UPDATE SET quantity = EXCLUDED.quantity,
      calculated_at = EXCLUDED.calculated_at, updated_at = NOW()
  `;
}

async function syncOrders(connection: ConnectionRow, accessToken: string, locationIds: string[]) {
  if (!locationIds.length) return 0;
  let cursor = "";
  let count = 0;
  const startAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  do {
    const page = await squareRequest<{ orders?: SquareObject[]; cursor?: string }>("/v2/orders/search", accessToken, {
      method: "POST",
      body: JSON.stringify({
        location_ids: locationIds,
        query: { filter: { date_time_filter: { created_at: { start_at: startAt } } }, sort: { sort_field: "CREATED_AT", sort_order: "ASC" } },
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    });
    for (const order of page.orders || []) { await upsertOrder(connection.id, order); count += 1; }
    cursor = page.cursor || "";
  } while (cursor);
  return count;
}

async function syncCatalog(connection: ConnectionRow, accessToken: string) {
  let cursor = "";
  let count = 0;
  do {
    const url = new URL(`${squareBase()}/v2/catalog/list`);
    url.searchParams.set("types", "ITEM,ITEM_VARIATION,CATEGORY,MODIFIER_LIST,MODIFIER,TAX,DISCOUNT");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await squareRequest<{ objects?: SquareObject[]; cursor?: string }>(`${url.pathname}${url.search}`, accessToken);
    for (const object of page.objects || []) { await upsertCatalog(connection.id, object); count += 1; }
    cursor = page.cursor || "";
  } while (cursor);
  return count;
}

async function syncInventory(connection: ConnectionRow, accessToken: string, locationIds: string[]) {
  const rows = await getSql()`
    SELECT external_object_id FROM square_catalog_objects
    WHERE connection_id = ${connection.id} AND object_type = 'ITEM_VARIATION' AND active = TRUE
  ` as unknown as Array<{ external_object_id: string }>;
  let count = 0;
  for (let index = 0; index < rows.length; index += 100) {
    const objectIds = rows.slice(index, index + 100).map((row) => row.external_object_id);
    const page = await squareRequest<{ counts?: SquareObject[] }>("/v2/inventory/counts/batch-retrieve", accessToken, {
      method: "POST",
      body: JSON.stringify({ catalog_object_ids: objectIds, location_ids: locationIds, states: ["IN_STOCK"] }),
    });
    for (const item of page.counts || []) { await upsertInventory(connection.id, item); count += 1; }
  }
  return count;
}

export async function syncSquareOperations() {
  await ensureSquareControlSchema();
  const connection = await activeConnection();
  if (!connection) return { skipped: true, reason: "Square is not connected." };
  const accessToken = await activeToken(connection);
  const locations = Array.isArray(connection.metadata?.locations) ? connection.metadata.locations as SquareObject[] : [];
  const locationIds = locations.filter((location) => location.status === "ACTIVE").map((location) => clean(location.id, 180)).filter(Boolean);
  const orders = await syncOrders(connection, accessToken, locationIds);
  const catalog = await syncCatalog(connection, accessToken);
  const inventory = await syncInventory(connection, accessToken, locationIds);
  await getSql()`UPDATE integration_connections SET last_sync_at = NOW(), updated_at = NOW() WHERE id = ${connection.id}`;
  return { skipped: false, orders, catalog, inventory, locations: locationIds.length };
}

export function verifySquareWebhookSignature(rawBody: string, suppliedSignature: string, notificationUrl?: string): boolean {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
  const url = notificationUrl || process.env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim();
  if (!key || !url || !suppliedSignature) return false;
  const expected = createHmac("sha256", key).update(`${url}${rawBody}`).digest("base64");
  return constantTimeEqual(expected, suppliedSignature);
}

export async function processSquareWebhook(rawBody: string) {
  await ensureSquareControlSchema();
  const event = JSON.parse(rawBody) as SquareObject;
  const eventId = clean(event.event_id || event.id, 180);
  const eventType = clean(event.type, 180);
  if (!eventId || !eventType) throw new Error("Square webhook did not include an event ID and type.");
  const merchantId = clean(event.merchant_id, 180);
  const locationId = clean(event.location_id, 180);
  const inserted = await getSql()`
    INSERT INTO square_webhook_events (id, event_id, event_type, merchant_id, location_id, payload)
    VALUES (${crypto.randomUUID()}, ${eventId}, ${eventType}, ${merchantId}, ${locationId}, ${rawBody}::jsonb)
    ON CONFLICT (event_id) DO NOTHING RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!inserted[0]) return { duplicate: true, eventId };

  try {
    const connection = await activeConnection(merchantId || undefined);
    if (!connection) {
      await getSql()`UPDATE square_webhook_events SET status = 'Ignored', error = 'No active Square connection.', processed_at = NOW() WHERE event_id = ${eventId}`;
      return { ignored: true, eventId };
    }
    const data = (event.data || {}) as SquareObject;
    const object = (data.object || {}) as SquareObject;
    const payment = (object.payment || {}) as SquareObject;
    const order = (object.order || {}) as SquareObject;
    const inventoryCounts = Array.isArray(object.inventory_counts) ? object.inventory_counts as SquareObject[] : [];
    const catalogObject = (object.catalog_object || {}) as SquareObject;
    let processed = 0;
    if (payment.id) { await upsertPayment(connection.id, payment); processed += 1; }
    if (order.id) { await upsertOrder(connection.id, order); processed += 1; }
    if (catalogObject.id) { await upsertCatalog(connection.id, catalogObject); processed += 1; }
    for (const item of inventoryCounts) { await upsertInventory(connection.id, item); processed += 1; }
    const status = processed ? "Processed" : "Ignored";
    await getSql()`UPDATE square_webhook_events SET status = ${status}, processed_at = NOW() WHERE event_id = ${eventId}`;
    return { duplicate: false, eventId, eventType, processed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getSql()`UPDATE square_webhook_events SET status = 'Failed', error = ${clean(message, 1000)}, processed_at = NOW() WHERE event_id = ${eventId}`;
    throw error;
  }
}

export async function squareOperationsDashboard() {
  await ensureSquareControlSchema();
  const summary = await getSql()`
    SELECT COUNT(*)::INTEGER AS orders, COALESCE(SUM(total_amount), 0) AS sales,
      COALESCE(SUM(tax_total), 0) AS taxes, COALESCE(SUM(tip_total), 0) AS tips
    FROM square_orders WHERE state = 'COMPLETED' AND created_at_square >= NOW() - INTERVAL '30 days'
  ` as unknown as Array<Record<string, unknown>>;
  const topItems = await getSql()`
    SELECT COALESCE(NULLIF(item_name, ''), NULLIF(variation_name, ''), 'Unnamed item') AS item,
      SUM(quantity) AS quantity, SUM(total_money) AS sales
    FROM square_order_lines l JOIN square_orders o ON o.id = l.square_order_id
    WHERE o.state = 'COMPLETED' AND o.created_at_square >= NOW() - INTERVAL '30 days'
    GROUP BY COALESCE(NULLIF(item_name, ''), NULLIF(variation_name, ''), 'Unnamed item')
    ORDER BY SUM(total_money) DESC LIMIT 20
  ` as unknown as Array<Record<string, unknown>>;
  const inventory = await getSql()`
    SELECT c.external_object_id, c.name, c.sku, c.price, COALESCE(SUM(i.quantity), 0) AS quantity
    FROM square_catalog_objects c
    LEFT JOIN square_inventory_counts i ON i.catalog_object_id = c.external_object_id AND i.state = 'IN_STOCK'
    WHERE c.object_type = 'ITEM_VARIATION' AND c.active = TRUE
    GROUP BY c.external_object_id, c.name, c.sku, c.price
    ORDER BY COALESCE(SUM(i.quantity), 0), c.name LIMIT 100
  ` as unknown as Array<Record<string, unknown>>;
  const webhooks = await getSql()`
    SELECT event_id, event_type, status, error, received_at, processed_at
    FROM square_webhook_events ORDER BY received_at DESC LIMIT 30
  ` as unknown as Array<Record<string, unknown>>;
  return {
    configured: {
      signatureKey: Boolean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim()),
      notificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL?.trim() || "",
      environment: squareEnvironment(),
    },
    summary: {
      orders: numberValue(summary[0]?.orders),
      sales: numberValue(summary[0]?.sales),
      taxes: numberValue(summary[0]?.taxes),
      tips: numberValue(summary[0]?.tips),
    },
    topItems: topItems.map((row) => ({ item: row.item, quantity: numberValue(row.quantity), sales: numberValue(row.sales) })),
    inventory: inventory.map((row) => ({
      catalogObjectId: row.external_object_id, name: row.name, sku: row.sku,
      price: numberValue(row.price), quantity: numberValue(row.quantity),
    })),
    webhooks: webhooks.map((row) => ({
      eventId: row.event_id, eventType: row.event_type, status: row.status,
      error: row.error, receivedAt: row.received_at, processedAt: row.processed_at,
    })),
  };
}
