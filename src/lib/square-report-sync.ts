import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureSquareControlSchema } from "@/lib/square-control";

const SQUARE_VERSION = process.env.SQUARE_API_VERSION?.trim() || "2026-07-15";

type SquareObject = Record<string, unknown>;
type SquareMoney = { amount?: number | string } | null | undefined;
type ConnectionRow = {
  id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  token_expires_at: string | null;
  metadata: Record<string, unknown>;
};

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: SquareMoney): number {
  return Math.round(numberValue(value?.amount)) / 100;
}

function squareEnvironment(): "sandbox" | "production" {
  return process.env.SQUARE_ENV?.toLowerCase() === "production" ? "production" : "sandbox";
}

function squareBase(): string {
  return squareEnvironment() === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

function integrationKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required before Square can store credentials.");
  return createHash("sha256").update(`corner-ops-integrations:${secret}`).digest();
}

function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", integrationKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptSecret(value: string): string {
  if (!value) return "";
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Stored Square credential is invalid.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    integrationKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function activeConnection(): Promise<ConnectionRow | null> {
  const rows = await getSql()`
    SELECT id, encrypted_access_token, encrypted_refresh_token, token_expires_at, metadata
    FROM integration_connections
    WHERE provider = 'Square' AND status = 'Active'
    ORDER BY updated_at DESC
    LIMIT 1
  ` as unknown as ConnectionRow[];
  return rows[0] || null;
}

async function activeToken(connection: ConnectionRow): Promise<string> {
  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : 0;
  if (!expiresAt || expiresAt > Date.now() + 24 * 60 * 60 * 1000) {
    return decryptSecret(connection.encrypted_access_token);
  }

  const refreshToken = decryptSecret(connection.encrypted_refresh_token);
  const clientId = process.env.SQUARE_APPLICATION_ID?.trim();
  const clientSecret = process.env.SQUARE_APPLICATION_SECRET?.trim();
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Square refresh credentials are unavailable.");
  }

  const response = await fetch(`${squareBase()}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(clean(payload.message || payload.error_description || "Square token refresh failed.", 500));
  }

  const accessToken = clean(payload.access_token, 5000);
  const nextRefresh = clean(payload.refresh_token || refreshToken, 5000);
  await getSql()`
    UPDATE integration_connections
    SET encrypted_access_token = ${encryptSecret(accessToken)},
      encrypted_refresh_token = ${encryptSecret(nextRefresh)},
      token_expires_at = ${payload.expires_at ? String(payload.expires_at) : null},
      updated_at = NOW()
    WHERE id = ${connection.id}
  `;
  return accessToken;
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
    const errors = Array.isArray(payload.errors)
      ? payload.errors as Array<Record<string, unknown>>
      : [];
    throw new Error(
      clean(errors[0]?.detail || errors[0]?.code || `Square request failed (${response.status}).`, 500),
    );
  }
  return payload as T;
}

async function upsertOrder(connectionId: string, order: SquareObject): Promise<void> {
  const externalOrderId = clean(order.id, 150);
  if (!externalOrderId) return;
  const source = (order.source || {}) as SquareObject;
  const rows = await getSql()`
    INSERT INTO square_orders (
      id, connection_id, external_order_id, location_id, state, source_name,
      created_at_square, updated_at_square, closed_at_square,
      total_amount, tax_total, tip_total, raw
    ) VALUES (
      ${crypto.randomUUID()}, ${connectionId}, ${externalOrderId},
      ${clean(order.location_id, 150)}, ${clean(order.state, 50)}, ${clean(source.name, 120)},
      ${order.created_at ? String(order.created_at) : null},
      ${order.updated_at ? String(order.updated_at) : null},
      ${order.closed_at ? String(order.closed_at) : null},
      ${money(order.total_money as SquareMoney)},
      ${money(order.total_tax_money as SquareMoney)},
      ${money(order.total_tip_money as SquareMoney)},
      ${JSON.stringify(order)}::jsonb
    )
    ON CONFLICT (external_order_id) DO UPDATE SET
      location_id = EXCLUDED.location_id,
      state = EXCLUDED.state,
      source_name = EXCLUDED.source_name,
      created_at_square = EXCLUDED.created_at_square,
      updated_at_square = EXCLUDED.updated_at_square,
      closed_at_square = EXCLUDED.closed_at_square,
      total_amount = EXCLUDED.total_amount,
      tax_total = EXCLUDED.tax_total,
      tip_total = EXCLUDED.tip_total,
      raw = EXCLUDED.raw,
      updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;

  const squareOrderId = rows[0]?.id;
  if (!squareOrderId) return;
  const lines = Array.isArray(order.line_items) ? order.line_items as SquareObject[] : [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const externalLineId = clean(line.uid || `${externalOrderId}:${index}`, 180);
    const modifiers = Array.isArray(line.modifiers) ? line.modifiers : [];
    await getSql()`
      INSERT INTO square_order_lines (
        id, square_order_id, external_line_id, catalog_object_id,
        item_name, variation_name, quantity, gross_sales,
        total_tax, total_discount, total_money, modifiers, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${squareOrderId}, ${externalLineId},
        ${clean(line.catalog_object_id, 180)}, ${clean(line.name, 240)},
        ${clean(line.variation_name, 240)}, ${numberValue(line.quantity)},
        ${money(line.gross_sales_money as SquareMoney)},
        ${money(line.total_tax_money as SquareMoney)},
        ${money(line.total_discount_money as SquareMoney)},
        ${money(line.total_money as SquareMoney)},
        ${JSON.stringify(modifiers)}::jsonb,
        ${JSON.stringify(line)}::jsonb
      )
      ON CONFLICT (square_order_id, external_line_id) DO UPDATE SET
        catalog_object_id = EXCLUDED.catalog_object_id,
        item_name = EXCLUDED.item_name,
        variation_name = EXCLUDED.variation_name,
        quantity = EXCLUDED.quantity,
        gross_sales = EXCLUDED.gross_sales,
        total_tax = EXCLUDED.total_tax,
        total_discount = EXCLUDED.total_discount,
        total_money = EXCLUDED.total_money,
        modifiers = EXCLUDED.modifiers,
        raw = EXCLUDED.raw
    `;
  }
}

export async function syncSquareReportRange(startAt: string, endAt: string) {
  await ensureSquareControlSchema();
  const connection = await activeConnection();
  if (!connection) return { skipped: true, reason: "Square is not connected.", orders: 0 };

  const locations = Array.isArray(connection.metadata?.locations)
    ? connection.metadata.locations as SquareObject[]
    : [];
  const locationIds = locations
    .filter((location) => location.status === "ACTIVE")
    .map((location) => clean(location.id, 180))
    .filter(Boolean);
  if (!locationIds.length) {
    return { skipped: true, reason: "Square has no active locations in the connection.", orders: 0 };
  }

  const accessToken = await activeToken(connection);
  let cursor = "";
  let orders = 0;
  do {
    const page = await squareRequest<{ orders?: SquareObject[]; cursor?: string }>(
      "/v2/orders/search",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          location_ids: locationIds,
          query: {
            filter: {
              date_time_filter: {
                created_at: {
                  start_at: startAt,
                  end_at: endAt,
                },
              },
            },
            sort: {
              sort_field: "CREATED_AT",
              sort_order: "ASC",
            },
          },
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      },
    );
    for (const order of page.orders || []) {
      await upsertOrder(connection.id, order);
      orders += 1;
    }
    cursor = page.cursor || "";
  } while (cursor);

  return { skipped: false, orders, startAt, endAt };
}
