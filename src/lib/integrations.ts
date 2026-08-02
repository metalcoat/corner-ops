import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as XLSX from "xlsx";
import { ensureSchema, getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const REVIEW_THRESHOLD = 0.9;
const PLAID_PRODUCTS = ["transactions"];
const SQUARE_VERSION = process.env.SQUARE_API_VERSION?.trim() || "2026-07-15";

type ConnectionProvider = "Plaid" | "Square" | "CSV";
type ConnectionRow = {
  id: string;
  provider: ConnectionProvider;
  business: Business;
  institution_name: string;
  external_item_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  token_expires_at: string | null;
  cursor: string;
  status: string;
  metadata: Record<string, unknown>;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
};

type ClassificationRule = {
  id: string;
  business: Business;
  priority: number;
  direction: string;
  field: "Merchant" | "Description" | "Either";
  match_type: "Contains" | "Exact";
  pattern: string;
  category: string;
  account_code: string;
  confidence: string | number;
};

type PlaidTransaction = {
  transaction_id: string;
  account_id: string;
  date: string;
  authorized_date?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  amount: number;
  pending: boolean;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
  payment_channel?: string | null;
  check_number?: string | null;
};

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function integrationKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required before integrations can store credentials.");
  return createHash("sha256").update(`corner-ops-integrations:${secret}`).digest();
}

function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", integrationKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value: string): string {
  if (!value) return "";
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Stored integration credential is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", integrationKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signedState(payload: Record<string, unknown>): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required.");
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSignedState(value: string): Record<string, unknown> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required.");
  const [encoded, supplied] = value.split(".");
  if (!encoded || !supplied) throw new Error("Integration authorization state is invalid.");
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!safeEqual(expected, supplied)) throw new Error("Integration authorization state is invalid.");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  if (Number(payload.expiresAt || 0) < Date.now()) throw new Error("Integration authorization state expired.");
  return payload;
}

function allowedOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("Integration callback requires HTTPS.");
  return url.origin;
}

export async function ensureIntegrationSchema(): Promise<void> {
  await ensureSchema();
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS integration_connections (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('Plaid', 'Square', 'CSV')),
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      institution_name TEXT NOT NULL,
      external_item_id TEXT NOT NULL,
      encrypted_access_token TEXT NOT NULL DEFAULT '',
      encrypted_refresh_token TEXT NOT NULL DEFAULT '',
      token_expires_at TIMESTAMPTZ,
      cursor TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Active',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_item_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS integration_connections_business_idx ON integration_connections (business, provider, status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id UUID PRIMARY KEY,
      connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      external_account_id TEXT NOT NULL UNIQUE,
      institution_name TEXT NOT NULL,
      name TEXT NOT NULL,
      official_name TEXT NOT NULL DEFAULT '',
      mask TEXT NOT NULL DEFAULT '',
      account_type TEXT NOT NULL DEFAULT '',
      account_subtype TEXT NOT NULL DEFAULT '',
      current_balance NUMERIC(14,2),
      available_balance NUMERIC(14,2),
      currency TEXT NOT NULL DEFAULT 'USD',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS bank_accounts_business_idx ON bank_accounts (business, institution_name, active)`;

  await sql`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id UUID PRIMARY KEY,
      connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      external_transaction_id TEXT NOT NULL UNIQUE,
      external_account_id TEXT NOT NULL DEFAULT '',
      transaction_date DATE NOT NULL,
      authorized_date DATE,
      merchant_name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      signed_amount NUMERIC(14,2) NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('Inflow', 'Outflow')),
      pending BOOLEAN NOT NULL DEFAULT FALSE,
      removed BOOLEAN NOT NULL DEFAULT FALSE,
      plaid_primary TEXT NOT NULL DEFAULT '',
      plaid_detail TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      account_code TEXT NOT NULL DEFAULT '',
      classification_source TEXT NOT NULL DEFAULT '',
      confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'Needs Review' CHECK (review_status IN ('Needs Review', 'Approved', 'Ignored')),
      user_override BOOLEAN NOT NULL DEFAULT FALSE,
      payment_channel TEXT NOT NULL DEFAULT '',
      check_number TEXT NOT NULL DEFAULT '',
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS bank_transactions_business_date_idx ON bank_transactions (business, transaction_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS bank_transactions_review_idx ON bank_transactions (business, review_status, transaction_date DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS classification_rules (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      priority INTEGER NOT NULL DEFAULT 100,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      direction TEXT NOT NULL DEFAULT 'Any' CHECK (direction IN ('Any', 'Inflow', 'Outflow')),
      field TEXT NOT NULL DEFAULT 'Either' CHECK (field IN ('Merchant', 'Description', 'Either')),
      match_type TEXT NOT NULL DEFAULT 'Contains' CHECK (match_type IN ('Contains', 'Exact')),
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      account_code TEXT NOT NULL,
      confidence NUMERIC(5,4) NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS classification_rules_business_idx ON classification_rules (business, active, priority)`;

  await sql`
    CREATE TABLE IF NOT EXISTS square_payments (
      id UUID PRIMARY KEY,
      connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      external_payment_id TEXT NOT NULL UNIQUE,
      business TEXT NOT NULL DEFAULT 'Tiki' CHECK (business = 'Tiki'),
      order_id TEXT NOT NULL DEFAULT '',
      location_id TEXT NOT NULL DEFAULT '',
      created_at_square TIMESTAMPTZ NOT NULL,
      updated_at_square TIMESTAMPTZ,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      tip_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS square_payments_date_idx ON square_payments (created_at_square DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS integration_sync_runs (
      id UUID PRIMARY KEY,
      connection_id UUID REFERENCES integration_connections(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      status TEXT NOT NULL CHECK (status IN ('Running', 'Success', 'Failed', 'Skipped')),
      records_added INTEGER NOT NULL DEFAULT 0,
      records_modified INTEGER NOT NULL DEFAULT 0,
      records_removed INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS integration_sync_runs_created_idx ON integration_sync_runs (started_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS operation_issues (
      id UUID PRIMARY KEY,
      issue_key TEXT NOT NULL UNIQUE,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      issue_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'Warning' CHECK (severity IN ('Info', 'Warning', 'Error')),
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved', 'Ignored')),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS operation_issues_status_idx ON operation_issues (status, severity, last_seen_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
      week_start DATE NOT NULL,
      week_end TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'Calculated' CHECK (status IN ('Calculated', 'Reviewed', 'Locked')),
      payload JSONB NOT NULL,
      generated_by TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (business, week_start)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id UUID PRIMARY KEY,
      run_key TEXT NOT NULL UNIQUE,
      local_date DATE NOT NULL,
      local_hour INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Running', 'Success', 'Failed', 'Skipped')),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;

  await sql`
    INSERT INTO accounting_accounts (id, business, code, name, account_type)
    VALUES
      (gen_random_uuid(), 'Corner Deli', '2150', 'Sales Tax Payable', 'Liability'),
      (gen_random_uuid(), 'Corner Deli', '2160', 'Tips Payable', 'Liability'),
      (gen_random_uuid(), 'Corner Deli', '5700', 'Bank Fees', 'Expense'),
      (gen_random_uuid(), 'Tiki', '2150', 'Sales Tax Payable', 'Liability'),
      (gen_random_uuid(), 'Tiki', '2160', 'Tips Payable', 'Liability'),
      (gen_random_uuid(), 'Tiki', '5700', 'Bank Fees', 'Expense')
    ON CONFLICT (business, code) DO NOTHING
  `;
}

function plaidEnvironment(): "sandbox" | "production" {
  return process.env.PLAID_ENV?.toLowerCase() === "production" ? "production" : "sandbox";
}

function plaidBase(): string {
  return plaidEnvironment() === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
}

function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID?.trim() && process.env.PLAID_SECRET?.trim());
}

async function plaidRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  if (!clientId || !secret) throw new Error("Plaid is not configured.");
  const response = await fetch(`${plaidBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
    cache: "no-store",
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(clean(payload.error_message || payload.display_message || `Plaid request failed (${response.status}).`, 500));
  return payload as T;
}

export async function createPlaidLinkToken(input: { business: Business; origin: string }) {
  await ensureIntegrationSchema();
  const origin = allowedOrigin(input.origin);
  const result = await plaidRequest<{ link_token: string; expiration: string }>("/link/token/create", {
    client_name: "Corner Ops",
    language: "en",
    country_codes: ["US"],
    products: PLAID_PRODUCTS,
    transactions: { days_requested: 730 },
    user: { client_user_id: `corner-ops-${input.business.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` },
    redirect_uri: `${origin}/ops/integrations`,
  });
  return { linkToken: result.link_token, expiration: result.expiration, environment: plaidEnvironment() };
}

async function institutionName(institutionId: string): Promise<string> {
  if (!institutionId) return "Connected bank";
  try {
    const result = await plaidRequest<{ institution: { name?: string } }>("/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US"],
    });
    return clean(result.institution?.name || "Connected bank", 120);
  } catch {
    return "Connected bank";
  }
}

async function upsertBankAccounts(connectionId: string, business: Business, institution: string, accounts: Array<Record<string, unknown>>) {
  for (const account of accounts) {
    const balances = (account.balances || {}) as Record<string, unknown>;
    await getSql()`
      INSERT INTO bank_accounts (
        id, connection_id, business, external_account_id, institution_name, name, official_name,
        mask, account_type, account_subtype, current_balance, available_balance, currency
      ) VALUES (
        ${crypto.randomUUID()}, ${connectionId}, ${business}, ${clean(account.account_id, 150)}, ${institution},
        ${clean(account.name, 150)}, ${clean(account.official_name, 150)}, ${clean(account.mask, 20)},
        ${clean(account.type, 50)}, ${clean(account.subtype, 80)},
        ${balances.current === null || balances.current === undefined ? null : numberValue(balances.current)},
        ${balances.available === null || balances.available === undefined ? null : numberValue(balances.available)},
        ${clean(balances.iso_currency_code || "USD", 10)}
      )
      ON CONFLICT (external_account_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id,
        business = EXCLUDED.business,
        institution_name = EXCLUDED.institution_name,
        name = EXCLUDED.name,
        official_name = EXCLUDED.official_name,
        mask = EXCLUDED.mask,
        account_type = EXCLUDED.account_type,
        account_subtype = EXCLUDED.account_subtype,
        current_balance = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        currency = EXCLUDED.currency,
        active = TRUE,
        updated_at = NOW()
    `;
  }
}

export async function exchangePlaidPublicToken(input: {
  business: Business;
  publicToken: string;
  institutionName?: string;
}) {
  await ensureIntegrationSchema();
  if (!input.publicToken) throw new Error("Plaid did not return a public token.");
  const exchanged = await plaidRequest<{ access_token: string; item_id: string }>("/item/public_token/exchange", {
    public_token: input.publicToken,
  });
  const item = await plaidRequest<{ item: { institution_id?: string } }>("/item/get", {
    access_token: exchanged.access_token,
  });
  const accountsResult = await plaidRequest<{ accounts: Array<Record<string, unknown>> }>("/accounts/get", {
    access_token: exchanged.access_token,
  });
  const institution = clean(input.institutionName, 120)
    || await institutionName(item.item?.institution_id || "");

  const rows = await getSql()`
    INSERT INTO integration_connections (
      id, provider, business, institution_name, external_item_id, encrypted_access_token, metadata
    ) VALUES (
      ${crypto.randomUUID()}, 'Plaid', ${input.business}, ${institution}, ${exchanged.item_id},
      ${encryptSecret(exchanged.access_token)}, ${JSON.stringify({ institutionId: item.item?.institution_id || "", environment: plaidEnvironment() })}::jsonb
    )
    ON CONFLICT (provider, external_item_id) DO UPDATE SET
      business = EXCLUDED.business,
      institution_name = EXCLUDED.institution_name,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      status = 'Active',
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  const connectionId = rows[0].id;
  await upsertBankAccounts(connectionId, input.business, institution, accountsResult.accounts || []);
  await syncBankConnection(connectionId);
  return { connectionId, institution };
}

function fallbackClassification(business: Business, transaction: PlaidTransaction) {
  const primary = clean(transaction.personal_finance_category?.primary, 100);
  const detail = clean(transaction.personal_finance_category?.detailed, 120);
  const direction = transaction.amount > 0 ? "Outflow" : "Inflow";
  let category = "Other Expense";
  let accountCode = "5900";
  let confidence = 0.55;

  if (direction === "Inflow") {
    category = "Sales / Income";
    accountCode = business === "Tiki" ? "4100" : "4000";
    confidence = 0.6;
  } else if (/BANK_FEES|OVERDRAFT|ATM_FEE/i.test(`${primary} ${detail}`)) {
    category = "Bank Fees";
    accountCode = "5700";
    confidence = 0.85;
  } else if (/RENT/i.test(`${primary} ${detail}`)) {
    category = "Rent and Occupancy";
    accountCode = "5200";
    confidence = 0.75;
  } else if (/UTILIT/i.test(`${primary} ${detail}`)) {
    category = "Utilities";
    accountCode = "5300";
    confidence = 0.75;
  } else if (/PAYROLL/i.test(`${primary} ${detail}`)) {
    category = "Payroll";
    accountCode = "5100";
    confidence = 0.8;
  } else if (/FOOD_AND_DRINK|GENERAL_MERCHANDISE|GROCER/i.test(`${primary} ${detail}`)) {
    category = "Cost of Goods Sold";
    accountCode = "5000";
    confidence = 0.65;
  } else if (/TRANSFER/i.test(`${primary} ${detail}`)) {
    category = "Bank Clearing / Transfer";
    accountCode = "1100";
    confidence = 0.7;
  }

  return { category, accountCode, confidence, source: "Plaid category", direction };
}

function ruleMatches(rule: ClassificationRule, transaction: PlaidTransaction, direction: string): boolean {
  if (rule.direction !== "Any" && rule.direction !== direction) return false;
  const merchant = clean(transaction.merchant_name, 240).toLowerCase();
  const description = clean(transaction.name, 240).toLowerCase();
  const pattern = rule.pattern.toLowerCase();
  const values = rule.field === "Merchant" ? [merchant] : rule.field === "Description" ? [description] : [merchant, description];
  return values.some((value) => rule.match_type === "Exact" ? value === pattern : value.includes(pattern));
}

function classifyWithRules(business: Business, transaction: PlaidTransaction, rules: ClassificationRule[]) {
  const fallback = fallbackClassification(business, transaction);
  const rule = rules.find((candidate) => ruleMatches(candidate, transaction, fallback.direction));
  if (!rule) return fallback;
  return {
    category: rule.category,
    accountCode: rule.account_code,
    confidence: numberValue(rule.confidence),
    source: `Rule: ${rule.pattern}`,
    direction: fallback.direction,
  };
}

async function rulesForBusiness(business: Business): Promise<ClassificationRule[]> {
  return await getSql()`
    SELECT id, business, priority, direction, field, match_type, pattern, category, account_code, confidence
    FROM classification_rules
    WHERE business = ${business} AND active = TRUE
    ORDER BY priority ASC, created_at ASC
  ` as unknown as ClassificationRule[];
}

async function loadConnection(connectionId: string): Promise<ConnectionRow> {
  const rows = await getSql()`
    SELECT id, provider, business, institution_name, external_item_id, encrypted_access_token,
      encrypted_refresh_token, token_expires_at, cursor, status, metadata, last_sync_at, created_at, updated_at
    FROM integration_connections
    WHERE id = ${connectionId}
    LIMIT 1
  ` as unknown as ConnectionRow[];
  if (!rows[0]) throw new Error("Integration connection was not found.");
  return rows[0];
}

async function startSync(connection: ConnectionRow) {
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO integration_sync_runs (id, connection_id, provider, business, status)
    VALUES (${id}, ${connection.id}, ${connection.provider}, ${connection.business}, 'Running')
  `;
  return id;
}

async function finishSync(id: string, status: "Success" | "Failed" | "Skipped", counts: { added?: number; modified?: number; removed?: number }, message = "") {
  await getSql()`
    UPDATE integration_sync_runs SET
      status = ${status},
      records_added = ${counts.added || 0},
      records_modified = ${counts.modified || 0},
      records_removed = ${counts.removed || 0},
      message = ${clean(message, 500)},
      completed_at = NOW()
    WHERE id = ${id}
  `;
}

async function upsertPlaidTransaction(connection: ConnectionRow, transaction: PlaidTransaction, rules: ClassificationRule[], modified = false) {
  const classification = classifyWithRules(connection.business, transaction, rules);
  const signedAmount = Math.round(-numberValue(transaction.amount) * 100) / 100;
  const reviewStatus = classification.confidence >= REVIEW_THRESHOLD ? "Approved" : "Needs Review";
  await getSql()`
    INSERT INTO bank_transactions (
      id, connection_id, business, external_transaction_id, external_account_id,
      transaction_date, authorized_date, merchant_name, description, signed_amount, direction,
      pending, plaid_primary, plaid_detail, category, account_code, classification_source,
      confidence, review_status, payment_channel, check_number, raw
    ) VALUES (
      ${crypto.randomUUID()}, ${connection.id}, ${connection.business}, ${transaction.transaction_id},
      ${clean(transaction.account_id, 150)}, ${transaction.date}, ${transaction.authorized_date || null},
      ${clean(transaction.merchant_name, 240)}, ${clean(transaction.name, 400)}, ${signedAmount},
      ${classification.direction}, ${Boolean(transaction.pending)},
      ${clean(transaction.personal_finance_category?.primary, 100)},
      ${clean(transaction.personal_finance_category?.detailed, 120)},
      ${classification.category}, ${classification.accountCode}, ${classification.source},
      ${classification.confidence}, ${reviewStatus}, ${clean(transaction.payment_channel, 50)},
      ${clean(transaction.check_number, 50)}, ${JSON.stringify(transaction)}::jsonb
    )
    ON CONFLICT (external_transaction_id) DO UPDATE SET
      external_account_id = EXCLUDED.external_account_id,
      transaction_date = EXCLUDED.transaction_date,
      authorized_date = EXCLUDED.authorized_date,
      merchant_name = EXCLUDED.merchant_name,
      description = EXCLUDED.description,
      signed_amount = EXCLUDED.signed_amount,
      direction = EXCLUDED.direction,
      pending = EXCLUDED.pending,
      removed = FALSE,
      plaid_primary = EXCLUDED.plaid_primary,
      plaid_detail = EXCLUDED.plaid_detail,
      category = CASE WHEN bank_transactions.user_override THEN bank_transactions.category ELSE EXCLUDED.category END,
      account_code = CASE WHEN bank_transactions.user_override THEN bank_transactions.account_code ELSE EXCLUDED.account_code END,
      classification_source = CASE WHEN bank_transactions.user_override THEN bank_transactions.classification_source ELSE EXCLUDED.classification_source END,
      confidence = CASE WHEN bank_transactions.user_override THEN bank_transactions.confidence ELSE EXCLUDED.confidence END,
      review_status = CASE WHEN bank_transactions.user_override THEN bank_transactions.review_status ELSE EXCLUDED.review_status END,
      payment_channel = EXCLUDED.payment_channel,
      check_number = EXCLUDED.check_number,
      raw = EXCLUDED.raw,
      updated_at = NOW()
  `;
  return modified;
}

export async function syncBankConnection(connectionId: string) {
  await ensureIntegrationSchema();
  const connection = await loadConnection(connectionId);
  if (connection.provider !== "Plaid") throw new Error("This connection is not a Plaid bank connection.");
  const syncId = await startSync(connection);
  try {
    const accessToken = decryptSecret(connection.encrypted_access_token);
    const rules = await rulesForBusiness(connection.business);
    let cursor = connection.cursor || undefined;
    let hasMore = true;
    let added = 0;
    let modified = 0;
    let removed = 0;

    while (hasMore) {
      const page = await plaidRequest<{
        added: PlaidTransaction[];
        modified: PlaidTransaction[];
        removed: Array<{ transaction_id: string }>;
        next_cursor: string;
        has_more: boolean;
      }>("/transactions/sync", { access_token: accessToken, cursor });
      for (const transaction of page.added || []) {
        await upsertPlaidTransaction(connection, transaction, rules);
        added += 1;
      }
      for (const transaction of page.modified || []) {
        await upsertPlaidTransaction(connection, transaction, rules, true);
        modified += 1;
      }
      for (const transaction of page.removed || []) {
        await getSql()`
          UPDATE bank_transactions SET removed = TRUE, updated_at = NOW()
          WHERE external_transaction_id = ${transaction.transaction_id}
        `;
        removed += 1;
      }
      cursor = page.next_cursor;
      hasMore = Boolean(page.has_more);
    }

    const accountsResult = await plaidRequest<{ accounts: Array<Record<string, unknown>> }>("/accounts/get", {
      access_token: accessToken,
    });
    await upsertBankAccounts(connection.id, connection.business, connection.institution_name, accountsResult.accounts || []);
    await getSql()`
      UPDATE integration_connections SET cursor = ${cursor || ''}, last_sync_at = NOW(), status = 'Active', updated_at = NOW()
      WHERE id = ${connection.id}
    `;
    await finishSync(syncId, "Success", { added, modified, removed }, "Plaid transaction sync completed.");
    return { added, modified, removed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSync(syncId, "Failed", {}, message);
    await createOperationIssue({
      issueKey: `bank-sync:${connection.id}`,
      business: connection.business,
      issueType: "Bank Sync",
      severity: "Error",
      title: `${connection.institution_name} bank sync failed`,
      details: message,
      reference: connection.id,
    });
    throw error;
  }
}

export async function syncAllBankConnections() {
  await ensureIntegrationSchema();
  const rows = await getSql()`
    SELECT id FROM integration_connections WHERE provider = 'Plaid' AND status = 'Active' ORDER BY created_at
  ` as unknown as Array<{ id: string }>;
  const results = [];
  for (const row of rows) {
    try {
      results.push({ id: row.id, ok: true, result: await syncBankConnection(row.id) });
    } catch (error) {
      results.push({ id: row.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function squareEnvironment(): "sandbox" | "production" {
  return process.env.SQUARE_ENV?.toLowerCase() === "production" ? "production" : "sandbox";
}

function squareConfigured(): boolean {
  return Boolean(process.env.SQUARE_APPLICATION_ID?.trim() && process.env.SQUARE_APPLICATION_SECRET?.trim());
}

function squareConnectBase(): string {
  return squareEnvironment() === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
}

async function squareRequest<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${squareConnectBase()}${path}`, {
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

export function squareAuthorizationUrl(origin: string): string {
  const applicationId = process.env.SQUARE_APPLICATION_ID?.trim();
  if (!applicationId || !process.env.SQUARE_APPLICATION_SECRET?.trim()) throw new Error("Square is not configured.");
  const safeOrigin = allowedOrigin(origin);
  const redirectUri = `${safeOrigin}/api/square/callback`;
  const state = signedState({ origin: safeOrigin, redirectUri, business: "Tiki", expiresAt: Date.now() + 10 * 60_000 });
  const url = new URL(`${squareConnectBase()}/oauth2/authorize`);
  url.searchParams.set("client_id", applicationId);
  url.searchParams.set("scope", "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ ITEMS_READ");
  url.searchParams.set("session", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

export async function exchangeSquareAuthorization(code: string, state: string) {
  await ensureIntegrationSchema();
  const payload = readSignedState(state);
  const origin = allowedOrigin(String(payload.origin || ""));
  const redirectUri = String(payload.redirectUri || `${origin}/api/square/callback`);
  const applicationId = process.env.SQUARE_APPLICATION_ID?.trim();
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET?.trim();
  if (!applicationId || !applicationSecret) throw new Error("Square is not configured.");

  const response = await fetch(`${squareConnectBase()}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });
  const token = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(clean(token.message || token.error_description || "Square authorization failed.", 500));
  const accessToken = clean(token.access_token, 5000);
  const refreshToken = clean(token.refresh_token, 5000);
  const merchantId = clean(token.merchant_id, 150);
  if (!accessToken || !merchantId) throw new Error("Square did not return a usable seller connection.");

  const locations = await squareRequest<{ locations?: Array<Record<string, unknown>> }>("/v2/locations", accessToken);
  const rows = await getSql()`
    INSERT INTO integration_connections (
      id, provider, business, institution_name, external_item_id, encrypted_access_token,
      encrypted_refresh_token, token_expires_at, metadata
    ) VALUES (
      ${crypto.randomUUID()}, 'Square', 'Tiki', 'Square', ${merchantId}, ${encryptSecret(accessToken)},
      ${encryptSecret(refreshToken)}, ${token.expires_at ? String(token.expires_at) : null},
      ${JSON.stringify({ environment: squareEnvironment(), locations: locations.locations || [] })}::jsonb
    )
    ON CONFLICT (provider, external_item_id) DO UPDATE SET
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      token_expires_at = EXCLUDED.token_expires_at,
      metadata = EXCLUDED.metadata,
      status = 'Active',
      updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  await syncSquareConnection(rows[0].id);
  return { origin, connectionId: rows[0].id };
}

async function activeSquareToken(connection: ConnectionRow): Promise<string> {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now() + 24 * 60 * 60 * 1000) return decryptSecret(connection.encrypted_access_token);
  const refreshToken = decryptSecret(connection.encrypted_refresh_token);
  const applicationId = process.env.SQUARE_APPLICATION_ID?.trim();
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET?.trim();
  if (!refreshToken || !applicationId || !applicationSecret) throw new Error("Square refresh credentials are unavailable.");
  const response = await fetch(`${squareConnectBase()}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const token = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(clean(token.message || token.error_description || "Square token refresh failed.", 500));
  const nextAccess = clean(token.access_token, 5000);
  const nextRefresh = clean(token.refresh_token || refreshToken, 5000);
  await getSql()`
    UPDATE integration_connections SET
      encrypted_access_token = ${encryptSecret(nextAccess)},
      encrypted_refresh_token = ${encryptSecret(nextRefresh)},
      token_expires_at = ${token.expires_at ? String(token.expires_at) : null},
      updated_at = NOW()
    WHERE id = ${connection.id}
  `;
  return nextAccess;
}

function moneyFromSquare(value: unknown): number {
  const amount = numberValue((value as Record<string, unknown> | null)?.amount);
  return Math.round(amount) / 100;
}

export async function syncSquareConnection(connectionId?: string) {
  await ensureIntegrationSchema();
  const rows = connectionId
    ? await getSql()`
        SELECT id, provider, business, institution_name, external_item_id, encrypted_access_token,
          encrypted_refresh_token, token_expires_at, cursor, status, metadata, last_sync_at, created_at, updated_at
        FROM integration_connections WHERE id = ${connectionId} LIMIT 1
      ` as unknown as ConnectionRow[]
    : await getSql()`
        SELECT id, provider, business, institution_name, external_item_id, encrypted_access_token,
          encrypted_refresh_token, token_expires_at, cursor, status, metadata, last_sync_at, created_at, updated_at
        FROM integration_connections WHERE provider = 'Square' AND status = 'Active' ORDER BY created_at LIMIT 1
      ` as unknown as ConnectionRow[];
  const connection = rows[0];
  if (!connection) return { added: 0, modified: 0, removed: 0, skipped: true };
  if (connection.provider !== "Square") throw new Error("This is not a Square connection.");
  const syncId = await startSync(connection);
  try {
    const accessToken = await activeSquareToken(connection);
    const locations = Array.isArray(connection.metadata?.locations)
      ? connection.metadata.locations as Array<Record<string, unknown>>
      : [];
    const locationId = clean(locations.find((location) => location.status === "ACTIVE")?.id || locations[0]?.id, 150);
    const begin = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    let cursor = "";
    let added = 0;
    do {
      const url = new URL(`${squareConnectBase()}/v2/payments`);
      url.searchParams.set("begin_time", begin);
      url.searchParams.set("sort_order", "ASC");
      url.searchParams.set("limit", "100");
      if (locationId) url.searchParams.set("location_id", locationId);
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = await squareRequest<{ payments?: Array<Record<string, unknown>>; cursor?: string }>(`${url.pathname}${url.search}`, accessToken);
      for (const payment of page.payments || []) {
        const paymentId = clean(payment.id, 150);
        if (!paymentId || !payment.created_at) continue;
        const result = await getSql()`
          INSERT INTO square_payments (
            id, connection_id, external_payment_id, order_id, location_id, created_at_square,
            updated_at_square, amount, tip_amount, status, raw
          ) VALUES (
            ${crypto.randomUUID()}, ${connection.id}, ${paymentId}, ${clean(payment.order_id, 150)},
            ${clean(payment.location_id, 150)}, ${String(payment.created_at)},
            ${payment.updated_at ? String(payment.updated_at) : null}, ${moneyFromSquare(payment.amount_money)},
            ${moneyFromSquare(payment.tip_money)}, ${clean(payment.status, 50)}, ${JSON.stringify(payment)}::jsonb
          )
          ON CONFLICT (external_payment_id) DO UPDATE SET
            order_id = EXCLUDED.order_id,
            location_id = EXCLUDED.location_id,
            updated_at_square = EXCLUDED.updated_at_square,
            amount = EXCLUDED.amount,
            tip_amount = EXCLUDED.tip_amount,
            status = EXCLUDED.status,
            raw = EXCLUDED.raw,
            updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        ` as unknown as Array<{ inserted: boolean }>;
        if (result[0]?.inserted) added += 1;
      }
      cursor = page.cursor || "";
    } while (cursor);

    await getSql()`
      UPDATE integration_connections SET last_sync_at = NOW(), status = 'Active', updated_at = NOW()
      WHERE id = ${connection.id}
    `;
    await finishSync(syncId, "Success", { added }, "Square payment sync completed.");
    return { added, modified: 0, removed: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSync(syncId, "Failed", {}, message);
    await createOperationIssue({
      issueKey: `square-sync:${connection.id}`,
      business: "Tiki",
      issueType: "Square Sync",
      severity: "Error",
      title: "Square sync failed",
      details: message,
      reference: connection.id,
    });
    throw error;
  }
}

export async function approveBankTransaction(input: {
  id: string;
  business: Business;
  category: string;
  accountCode: string;
  actor: string;
  teach: boolean;
}) {
  await ensureIntegrationSchema();
  const rows = await getSql()`
    UPDATE bank_transactions SET
      category = ${clean(input.category, 120)},
      account_code = ${clean(input.accountCode, 20)},
      classification_source = 'Owner override',
      confidence = 1,
      review_status = 'Approved',
      user_override = TRUE,
      updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business}
    RETURNING merchant_name, description, direction
  ` as unknown as Array<{ merchant_name: string; description: string; direction: "Inflow" | "Outflow" }>;
  if (!rows[0]) throw new Error("Bank transaction was not found.");

  if (input.teach) {
    const pattern = clean(rows[0].merchant_name || rows[0].description, 160);
    if (pattern) {
      await getSql()`
        INSERT INTO classification_rules (
          id, business, priority, direction, field, match_type, pattern, category, account_code, confidence, created_by
        ) VALUES (
          ${crypto.randomUUID()}, ${input.business}, 50, ${rows[0].direction},
          ${rows[0].merchant_name ? 'Merchant' : 'Description'}, 'Contains', ${pattern},
          ${clean(input.category, 120)}, ${clean(input.accountCode, 20)}, 1, ${input.actor}
        )
      `;
    }
  }
  return { approved: true };
}

function csvDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = clean(value, 80);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function rowValue(row: Record<string, unknown>, names: string[]): unknown {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

export async function importBankFile(input: {
  business: Business;
  institutionName: string;
  fileName: string;
  bytes: ArrayBuffer;
  actor: string;
}) {
  await ensureIntegrationSchema();
  const workbook = XLSX.read(Buffer.from(input.bytes), { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The bank file did not contain a readable worksheet.");
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, dateNF: "yyyy-mm-dd" }) as Record<string, unknown>[];
  const externalItemId = `csv:${input.business}:${input.institutionName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const connectionRows = await getSql()`
    INSERT INTO integration_connections (id, provider, business, institution_name, external_item_id, metadata)
    VALUES (
      ${crypto.randomUUID()}, 'CSV', ${input.business}, ${clean(input.institutionName, 120)}, ${externalItemId},
      ${JSON.stringify({ lastFile: input.fileName, actor: input.actor })}::jsonb
    )
    ON CONFLICT (provider, external_item_id) DO UPDATE SET
      institution_name = EXCLUDED.institution_name,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  const connection = await loadConnection(connectionRows[0].id);
  const rules = await rulesForBusiness(input.business);
  let imported = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const date = csvDate(rowValue(row, ["Date", "Transaction Date", "Posted Date"]));
    const merchant = clean(rowValue(row, ["Merchant", "Payee", "Name"]), 240);
    const description = clean(rowValue(row, ["Description", "Memo", "Details", "Transaction"]), 400) || merchant;
    if (!date || !description) continue;
    const debit = Math.abs(numberValue(rowValue(row, ["Debit", "Withdrawal", "Amount Debited"]))) || 0;
    const credit = Math.abs(numberValue(rowValue(row, ["Credit", "Deposit", "Amount Credited"]))) || 0;
    const rawAmount = numberValue(rowValue(row, ["Amount", "Transaction Amount", "Signed Amount"]));
    const signedAmount = credit ? credit : debit ? -debit : rawAmount;
    if (!signedAmount) continue;
    const transaction: PlaidTransaction = {
      transaction_id: createHash("sha256").update(`${externalItemId}|${date}|${description}|${signedAmount}|${index}`).digest("hex"),
      account_id: externalItemId,
      date,
      merchant_name: merchant,
      name: description,
      amount: -signedAmount,
      pending: false,
    };
    await upsertPlaidTransaction(connection, transaction, rules);
    imported += 1;
  }

  await getSql()`UPDATE integration_connections SET last_sync_at = NOW(), updated_at = NOW() WHERE id = ${connection.id}`;
  return { imported, rowsRead: rows.length };
}

export async function createOperationIssue(input: {
  issueKey: string;
  business: Business;
  issueType: string;
  severity: "Info" | "Warning" | "Error";
  title: string;
  details?: string;
  reference?: string;
}) {
  await ensureIntegrationSchema();
  await getSql()`
    INSERT INTO operation_issues (
      id, issue_key, business, issue_type, severity, title, details, reference
    ) VALUES (
      ${crypto.randomUUID()}, ${clean(input.issueKey, 240)}, ${input.business}, ${clean(input.issueType, 100)},
      ${input.severity}, ${clean(input.title, 240)}, ${clean(input.details, 1000)}, ${clean(input.reference, 240)}
    )
    ON CONFLICT (issue_key) DO UPDATE SET
      severity = EXCLUDED.severity,
      title = EXCLUDED.title,
      details = EXCLUDED.details,
      reference = EXCLUDED.reference,
      status = 'Open',
      last_seen_at = NOW(),
      resolved_at = NULL
  `;
}

export async function integrationDashboard(business?: Business) {
  await ensureIntegrationSchema();
  const connections = business
    ? await getSql()`
        SELECT id, provider, business, institution_name, status, metadata, last_sync_at, created_at, updated_at
        FROM integration_connections WHERE business = ${business} ORDER BY provider, created_at
      ` as unknown as Array<Record<string, unknown>>
    : await getSql()`
        SELECT id, provider, business, institution_name, status, metadata, last_sync_at, created_at, updated_at
        FROM integration_connections ORDER BY business, provider, created_at
      ` as unknown as Array<Record<string, unknown>>;
  const accounts = business
    ? await getSql()`
        SELECT id, business, institution_name, name, official_name, mask, account_type, account_subtype,
          current_balance, available_balance, currency, active, updated_at
        FROM bank_accounts WHERE business = ${business} ORDER BY institution_name, name
      ` as unknown as Array<Record<string, unknown>>
    : [];
  const transactions = business
    ? await getSql()`
        SELECT id, transaction_date, merchant_name, description, signed_amount, direction, pending,
          category, account_code, classification_source, confidence, review_status, user_override
        FROM bank_transactions
        WHERE business = ${business} AND removed = FALSE
        ORDER BY transaction_date DESC, created_at DESC
        LIMIT 150
      ` as unknown as Array<Record<string, unknown>>
    : [];
  const accountingAccounts = business
    ? await getSql()`
        SELECT code, name, account_type FROM accounting_accounts
        WHERE business = ${business} AND active = TRUE
        ORDER BY code
      ` as unknown as Array<Record<string, unknown>>
    : [];
  const syncRuns = await getSql()`
    SELECT id, connection_id, provider, business, status, records_added, records_modified,
      records_removed, message, started_at, completed_at
    FROM integration_sync_runs ORDER BY started_at DESC LIMIT 40
  ` as unknown as Array<Record<string, unknown>>;
  const issues = await getSql()`
    SELECT id, business, issue_type, severity, title, details, reference, status, first_seen_at, last_seen_at
    FROM operation_issues WHERE status = 'Open' ORDER BY severity DESC, last_seen_at DESC LIMIT 50
  ` as unknown as Array<Record<string, unknown>>;
  const schedulerRuns = await getSql()`
    SELECT id, run_key, local_date, local_hour, status, details, started_at, completed_at
    FROM scheduler_runs ORDER BY started_at DESC LIMIT 20
  ` as unknown as Array<Record<string, unknown>>;
  const payrollRuns = business
    ? await getSql()`
        SELECT id, business, week_start, week_end, status, generated_by, generated_at, updated_at
        FROM payroll_runs WHERE business = ${business} ORDER BY week_start DESC LIMIT 20
      ` as unknown as Array<Record<string, unknown>>
    : [];
  const squareSummary = business === "Tiki"
    ? await getSql()`
        SELECT COALESCE(SUM(amount), 0) AS sales, COALESCE(SUM(tip_amount), 0) AS tips, COUNT(*) AS payments
        FROM square_payments
        WHERE status = 'COMPLETED' AND created_at_square >= NOW() - INTERVAL '30 days'
      ` as unknown as Array<Record<string, unknown>>
    : [];

  return {
    configuration: {
      plaid: plaidConfigured(),
      plaidEnvironment: plaidEnvironment(),
      square: squareConfigured(),
      squareEnvironment: squareEnvironment(),
      cron: Boolean(process.env.CRON_SECRET?.trim()),
      alerts: Boolean(process.env.ALERT_FROM_EMAIL?.trim()),
    },
    connections: connections.map((row) => ({
      id: row.id,
      provider: row.provider,
      business: row.business,
      institutionName: row.institution_name,
      status: row.status,
      metadata: row.metadata,
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    accounts: accounts.map((row) => ({
      ...row,
      institutionName: row.institution_name,
      officialName: row.official_name,
      accountType: row.account_type,
      accountSubtype: row.account_subtype,
      currentBalance: row.current_balance === null ? null : numberValue(row.current_balance),
      availableBalance: row.available_balance === null ? null : numberValue(row.available_balance),
      updatedAt: row.updated_at,
    })),
    transactions: transactions.map((row) => ({
      ...row,
      transactionDate: row.transaction_date,
      merchantName: row.merchant_name,
      signedAmount: numberValue(row.signed_amount),
      accountCode: row.account_code,
      classificationSource: row.classification_source,
      confidence: numberValue(row.confidence),
      reviewStatus: row.review_status,
      userOverride: row.user_override,
    })),
    accountingAccounts: accountingAccounts.map((row) => ({ ...row, accountType: row.account_type })),
    syncRuns: syncRuns.map((row) => ({
      ...row,
      connectionId: row.connection_id,
      recordsAdded: row.records_added,
      recordsModified: row.records_modified,
      recordsRemoved: row.records_removed,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
    issues: issues.map((row) => ({
      ...row,
      issueType: row.issue_type,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
    schedulerRuns: schedulerRuns.map((row) => ({
      ...row,
      runKey: row.run_key,
      localDate: row.local_date,
      localHour: row.local_hour,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
    payrollRuns: payrollRuns.map((row) => ({
      ...row,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      generatedBy: row.generated_by,
      generatedAt: row.generated_at,
      updatedAt: row.updated_at,
    })),
    squareSummary: squareSummary[0]
      ? { sales: numberValue(squareSummary[0].sales), tips: numberValue(squareSummary[0].tips), payments: numberValue(squareSummary[0].payments) }
      : { sales: 0, tips: 0, payments: 0 },
  };
}

export function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    weekday: values.weekday,
  };
}
