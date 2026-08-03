import { createSign } from "node:crypto";
import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const MAX_RECEIPT_BYTES = 40 * 1024 * 1024;
const RECEIPT_MIME_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/tiff",
  "image/jpeg",
  "image/png",
  "image/bmp",
  "image/webp",
]);

let schemaPromise: Promise<void> | null = null;
let googleTokenCache: { value: string; expiresAt: number } | null = null;

type BankTransactionRow = {
  id: string;
  business: Business;
  external_account_id: string;
  transaction_date: string;
  merchant_name: string;
  description: string;
  signed_amount: string | number;
  direction: "Inflow" | "Outflow";
  account_type: string;
  account_subtype: string;
  account_name: string;
};

type ReceiptRow = {
  id: string;
  business: Business;
  source: "Upload" | "Google Drive";
  source_key: string;
  external_file_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: string | number;
  source_url: string;
  storage_url: string;
  storage_pathname: string;
  modified_at_source: string | null;
  ocr_status: string;
  merchant_name: string;
  receipt_date: string | null;
  total_amount: string | number | null;
  tax_amount: string | number | null;
  currency: string;
  raw_text: string;
  entities: Record<string, unknown>;
  ocr_error: string;
  created_at: string;
  updated_at: string;
};

type DocumentEntity = {
  type?: string;
  mentionText?: string;
  confidence?: number;
  normalizedValue?: {
    text?: string;
    moneyValue?: { currencyCode?: string; units?: string | number; nanos?: number };
    dateValue?: { year?: number; month?: number; day?: number };
  };
};

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function dateKey(value: unknown): string | null {
  const text = clean(value, 80);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function daysApart(left: string, right: string): number {
  return Math.abs(
    Math.round((new Date(`${left}T12:00:00Z`).getTime() - new Date(`${right}T12:00:00Z`).getTime()) / 86_400_000),
  );
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function serviceAccountPrivateKey(): string {
  return (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
}

function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() && serviceAccountPrivateKey());
}

function documentAiConfigured(): boolean {
  return Boolean(
    googleConfigured()
      && process.env.GOOGLE_CLOUD_PROJECT_ID?.trim()
      && process.env.GOOGLE_DOCUMENT_AI_EXPENSE_PROCESSOR_ID?.trim(),
  );
}

function driveFolder(business: Business): string {
  return business === "Corner Deli"
    ? process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_CORNER_DELI?.trim() || ""
    : process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_TIKI?.trim() || "";
}

async function googleAccessToken(): Promise<string> {
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) return googleTokenCache.value;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = serviceAccountPrivateKey();
  if (!email || !privateKey) throw new Error("Google service-account credentials are not configured.");

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  const result = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !result.access_token) {
    throw new Error(clean(result.error_description || `Google authentication failed (${response.status}).`, 500));
  }
  googleTokenCache = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(300, Number(result.expires_in || 3600)) * 1000,
  };
  return result.access_token;
}

async function googleJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await googleAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(clean(error?.message || `Google request failed (${response.status}).`, 500));
  }
  return payload as T;
}

export function supportedReceiptMimeType(mimeType: string): boolean {
  return RECEIPT_MIME_TYPES.has(mimeType.toLowerCase());
}

export function validateReceiptFile(input: { size: number; mimeType: string; fileName: string }) {
  if (!input.size) throw new Error("The receipt file is empty.");
  if (input.size > MAX_RECEIPT_BYTES) throw new Error("Receipt files are limited to 40 MB.");
  if (!supportedReceiptMimeType(input.mimeType)) {
    throw new Error(`${input.fileName || "Receipt"} is not a supported PDF or image file.`);
  }
}

export function ensureExpenseControlSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureAccountingControlSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS credit_card_transfer_matches (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
          card_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
          amount NUMERIC(14,2) NOT NULL,
          date_difference INTEGER NOT NULL DEFAULT 0,
          confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'Suggested' CHECK (status IN ('Suggested', 'Matched', 'Ignored')),
          matched_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          matched_at TIMESTAMPTZ,
          UNIQUE (bank_transaction_id, card_transaction_id)
        )
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS card_transfer_active_bank_unique
        ON credit_card_transfer_matches (bank_transaction_id)
        WHERE status <> 'Ignored'
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS card_transfer_active_card_unique
        ON credit_card_transfer_matches (card_transaction_id)
        WHERE status <> 'Ignored'
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS receipt_documents (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          source TEXT NOT NULL CHECK (source IN ('Upload', 'Google Drive')),
          source_key TEXT NOT NULL UNIQUE,
          external_file_id TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL DEFAULT 0,
          source_url TEXT NOT NULL DEFAULT '',
          storage_url TEXT NOT NULL DEFAULT '',
          storage_pathname TEXT NOT NULL DEFAULT '',
          modified_at_source TIMESTAMPTZ,
          ocr_status TEXT NOT NULL DEFAULT 'Pending' CHECK (ocr_status IN ('Pending', 'Processed', 'Failed', 'Needs Configuration', 'Unsupported')),
          merchant_name TEXT NOT NULL DEFAULT '',
          receipt_date DATE,
          total_amount NUMERIC(14,2),
          tax_amount NUMERIC(14,2),
          currency TEXT NOT NULL DEFAULT 'USD',
          raw_text TEXT NOT NULL DEFAULT '',
          entities JSONB NOT NULL DEFAULT '{}'::jsonb,
          ocr_error TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS receipt_documents_business_idx ON receipt_documents (business, receipt_date DESC, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS receipt_documents_status_idx ON receipt_documents (business, ocr_status, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS receipt_transaction_matches (
          id UUID PRIMARY KEY,
          receipt_id UUID NOT NULL REFERENCES receipt_documents(id) ON DELETE CASCADE,
          bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
          amount_variance NUMERIC(14,2) NOT NULL DEFAULT 0,
          date_difference INTEGER NOT NULL DEFAULT 0,
          merchant_score NUMERIC(5,4) NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'Suggested' CHECK (status IN ('Suggested', 'Matched', 'Ignored')),
          matched_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          matched_at TIMESTAMPTZ,
          UNIQUE (receipt_id, bank_transaction_id)
        )
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS receipt_active_document_unique
        ON receipt_transaction_matches (receipt_id)
        WHERE status <> 'Ignored'
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS receipt_active_transaction_unique
        ON receipt_transaction_matches (bank_transaction_id)
        WHERE status = 'Matched'
      `;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function descriptionSignalsPayment(value: string): boolean {
  return /(payment|autopay|auto pay|card pymt|credit card|online pmt|thank you|transfer)/i.test(value);
}

async function applyTransferMatch(id: string, actor: string) {
  const rows = await getSql()`
    SELECT m.id, m.bank_transaction_id, m.card_transaction_id
    FROM credit_card_transfer_matches m
    WHERE m.id = ${id} LIMIT 1
  ` as unknown as Array<{ id: string; bank_transaction_id: string; card_transaction_id: string }>;
  const match = rows[0];
  if (!match) throw new Error("Credit-card payment match was not found.");

  await getSql()`
    UPDATE bank_transactions SET
      category = 'Credit Card Payment',
      account_code = '2100',
      classification_source = 'Matched credit-card payment',
      confidence = 1,
      review_status = 'Approved',
      updated_at = NOW()
    WHERE id = ${match.bank_transaction_id}
  `;
  await getSql()`
    UPDATE bank_transactions SET
      category = 'Credit Card Payment Mirror',
      account_code = '2100',
      classification_source = 'Matched to bank payment',
      confidence = 1,
      review_status = 'Ignored',
      updated_at = NOW()
    WHERE id = ${match.card_transaction_id}
  `;
  await getSql()`
    UPDATE credit_card_transfer_matches SET
      status = 'Matched', matched_by = ${clean(actor, 255)}, matched_at = NOW(), updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function refreshCreditCardPaymentMatches(business?: Business) {
  await ensureExpenseControlSchema();
  const businesses: Business[] = business ? [business] : ["Corner Deli", "Tiki"];
  const result: Record<string, unknown> = {};

  for (const activeBusiness of businesses) {
    const rows = await getSql()`
      SELECT t.id, t.business, t.external_account_id, t.transaction_date, t.merchant_name,
        t.description, t.signed_amount, t.direction, a.account_type, a.account_subtype,
        a.name AS account_name
      FROM bank_transactions t
      JOIN bank_accounts a ON a.external_account_id = t.external_account_id
      LEFT JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
      WHERE t.business = ${activeBusiness}
        AND t.pending = FALSE AND t.removed = FALSE
        AND t.transaction_date >= CURRENT_DATE - INTERVAL '180 days'
        AND p.id IS NULL
      ORDER BY t.transaction_date DESC
    ` as unknown as BankTransactionRow[];

    const bankPayments = rows.filter((row) => row.account_type !== "credit" && numberValue(row.signed_amount) < 0);
    const cardCredits = rows.filter((row) => row.account_type === "credit" && numberValue(row.signed_amount) > 0);
    let suggested = 0;
    let autoMatched = 0;

    for (const bank of bankPayments) {
      const amount = Math.abs(numberValue(bank.signed_amount));
      const candidates = cardCredits
        .map((card) => {
          const variance = Math.abs(amount - Math.abs(numberValue(card.signed_amount)));
          const dateDifference = daysApart(bank.transaction_date, card.transaction_date);
          const signal = descriptionSignalsPayment(`${bank.merchant_name} ${bank.description} ${card.merchant_name} ${card.description}`);
          const confidence = Math.max(0, Math.min(1,
            (variance <= 0.01 ? 0.7 : variance <= 0.5 ? 0.45 : 0)
            + (dateDifference === 0 ? 0.2 : dateDifference <= 2 ? 0.15 : dateDifference <= 5 ? 0.08 : 0)
            + (signal ? 0.1 : 0),
          ));
          return { card, variance, dateDifference, confidence };
        })
        .filter((candidate) => candidate.variance <= 0.5 && candidate.dateDifference <= 7)
        .sort((left, right) => right.confidence - left.confidence);
      const best = candidates[0];
      if (!best || best.confidence < 0.75) continue;

      const inserted = await getSql()`
        INSERT INTO credit_card_transfer_matches (
          id, business, bank_transaction_id, card_transaction_id, amount,
          date_difference, confidence, status
        ) VALUES (
          ${crypto.randomUUID()}, ${activeBusiness}, ${bank.id}, ${best.card.id}, ${amount},
          ${best.dateDifference}, ${best.confidence}, 'Suggested'
        )
        ON CONFLICT (bank_transaction_id, card_transaction_id) DO UPDATE SET
          amount = EXCLUDED.amount,
          date_difference = EXCLUDED.date_difference,
          confidence = EXCLUDED.confidence,
          updated_at = NOW()
        RETURNING id, status
      ` as unknown as Array<{ id: string; status: string }>;
      if (!inserted[0]) continue;
      suggested += inserted[0].status === "Suggested" ? 1 : 0;
      const uniqueHighConfidence = best.confidence >= 0.97
        && (!candidates[1] || best.confidence - candidates[1].confidence >= 0.12);
      if (uniqueHighConfidence && inserted[0].status !== "Matched") {
        await applyTransferMatch(inserted[0].id, "Automatic transfer matcher");
        autoMatched += 1;
      }
    }
    result[activeBusiness] = { bankPayments: bankPayments.length, cardCredits: cardCredits.length, suggested, autoMatched };
  }
  return result;
}

export async function reviewCreditCardPaymentMatch(input: {
  id: string;
  business: Business;
  accept: boolean;
  actor: string;
}) {
  await ensureExpenseControlSchema();
  const rows = await getSql()`
    SELECT id FROM credit_card_transfer_matches WHERE id = ${input.id} AND business = ${input.business} LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Credit-card payment match was not found.");
  if (input.accept) {
    await applyTransferMatch(input.id, input.actor);
    return { id: input.id, status: "Matched" };
  }
  await getSql()`
    UPDATE credit_card_transfer_matches SET status = 'Ignored', matched_by = ${clean(input.actor, 255)}, updated_at = NOW()
    WHERE id = ${input.id}
  `;
  return { id: input.id, status: "Ignored" };
}

function entityType(entity: DocumentEntity): string {
  return clean(entity.type, 120).toLowerCase();
}

function entityText(entity: DocumentEntity): string {
  return clean(entity.normalizedValue?.text || entity.mentionText, 500);
}

function moneyFromEntity(entity?: DocumentEntity): number | null {
  if (!entity) return null;
  const money = entity.normalizedValue?.moneyValue;
  if (money) {
    const value = Number(money.units || 0) + Number(money.nanos || 0) / 1_000_000_000;
    if (Number.isFinite(value)) return roundMoney(value);
  }
  const parsed = numberValue(entityText(entity));
  return parsed ? roundMoney(parsed) : null;
}

function dateFromEntity(entity?: DocumentEntity): string | null {
  if (!entity) return null;
  const date = entity.normalizedValue?.dateValue;
  if (date?.year && date.month && date.day) {
    return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  }
  return dateKey(entityText(entity));
}

function firstEntity(entities: DocumentEntity[], patterns: RegExp[]): DocumentEntity | undefined {
  return entities.find((entity) => patterns.some((pattern) => pattern.test(entityType(entity))));
}

function parseDocumentAiResult(payload: Record<string, unknown>) {
  const document = (payload.document || {}) as Record<string, unknown>;
  const entities = Array.isArray(document.entities) ? document.entities as DocumentEntity[] : [];
  const merchantEntity = firstEntity(entities, [/supplier_name/, /merchant_name/, /vendor_name/]);
  const dateEntity = firstEntity(entities, [/receipt_date/, /purchase_date/, /^date$/]);
  const totalEntity = firstEntity(entities, [/total_amount/, /grand_total/, /^total$/]);
  const taxEntity = firstEntity(entities, [/total_tax_amount/, /tax_amount/, /^tax$/]);
  const currencyEntity = firstEntity(entities, [/currency/]);
  const rawText = clean(document.text, 200_000);

  let total = moneyFromEntity(totalEntity);
  if (total === null && rawText) {
    const fallback = [...rawText.matchAll(/(?:total|amount due)\s*[:$]?\s*([0-9,]+\.\d{2})/gi)].pop();
    total = fallback ? roundMoney(numberValue(fallback[1])) : null;
  }

  return {
    merchant: entityText(merchantEntity || {}) || clean(rawText.split(/\r?\n/).find(Boolean), 180),
    receiptDate: dateFromEntity(dateEntity),
    totalAmount: total,
    taxAmount: moneyFromEntity(taxEntity),
    currency: clean(currencyEntity?.normalizedValue?.moneyValue?.currencyCode || entityText(currencyEntity || {}) || "USD", 10).toUpperCase(),
    rawText,
    entities,
  };
}

async function processWithDocumentAi(bytes: ArrayBuffer, mimeType: string) {
  if (!documentAiConfigured()) throw new Error("Google Document AI expense processing is not configured.");
  const project = process.env.GOOGLE_CLOUD_PROJECT_ID!.trim();
  const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION?.trim() || "us";
  const processor = process.env.GOOGLE_DOCUMENT_AI_EXPENSE_PROCESSOR_ID!.trim();
  const endpoint = `https://${location}-documentai.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/processors/${encodeURIComponent(processor)}:process`;
  const payload = await googleJson<Record<string, unknown>>(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rawDocument: {
        content: Buffer.from(bytes).toString("base64"),
        mimeType,
      },
    }),
  });
  return parseDocumentAiResult(payload);
}

export async function ingestReceipt(input: {
  business: Business;
  source: "Upload" | "Google Drive";
  sourceKey: string;
  externalFileId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceUrl?: string;
  storageUrl?: string;
  storagePathname?: string;
  modifiedAtSource?: string | null;
  bytes: ArrayBuffer;
  actor: string;
}) {
  await ensureExpenseControlSchema();
  validateReceiptFile({ size: input.sizeBytes, mimeType: input.mimeType, fileName: input.fileName });
  const rows = await getSql()`
    INSERT INTO receipt_documents (
      id, business, source, source_key, external_file_id, file_name, mime_type, size_bytes,
      source_url, storage_url, storage_pathname, modified_at_source, ocr_status, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.source}, ${clean(input.sourceKey, 500)},
      ${clean(input.externalFileId, 300)}, ${clean(input.fileName, 255)}, ${input.mimeType}, ${input.sizeBytes},
      ${clean(input.sourceUrl, 1000)}, ${clean(input.storageUrl, 1000)}, ${clean(input.storagePathname, 1000)},
      ${input.modifiedAtSource || null}, ${documentAiConfigured() ? "Pending" : "Needs Configuration"}, ${clean(input.actor, 255)}
    )
    ON CONFLICT (source_key) DO UPDATE SET
      file_name = EXCLUDED.file_name,
      mime_type = EXCLUDED.mime_type,
      size_bytes = EXCLUDED.size_bytes,
      source_url = EXCLUDED.source_url,
      storage_url = CASE WHEN EXCLUDED.storage_url <> '' THEN EXCLUDED.storage_url ELSE receipt_documents.storage_url END,
      storage_pathname = CASE WHEN EXCLUDED.storage_pathname <> '' THEN EXCLUDED.storage_pathname ELSE receipt_documents.storage_pathname END,
      modified_at_source = EXCLUDED.modified_at_source,
      ocr_status = EXCLUDED.ocr_status,
      ocr_error = '',
      updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  const id = rows[0].id;

  if (!documentAiConfigured()) return { id, status: "Needs Configuration" };
  try {
    const parsed = await processWithDocumentAi(input.bytes, input.mimeType);
    await getSql()`
      UPDATE receipt_documents SET
        ocr_status = 'Processed',
        merchant_name = ${clean(parsed.merchant, 240)},
        receipt_date = ${parsed.receiptDate},
        total_amount = ${parsed.totalAmount},
        tax_amount = ${parsed.taxAmount},
        currency = ${parsed.currency || "USD"},
        raw_text = ${parsed.rawText},
        entities = ${JSON.stringify(parsed.entities)}::jsonb,
        ocr_error = '',
        updated_at = NOW()
      WHERE id = ${id}
    `;
    await refreshReceiptMatches(input.business);
    return { id, status: "Processed", ...parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getSql()`
      UPDATE receipt_documents SET ocr_status = 'Failed', ocr_error = ${clean(message, 1000)}, updated_at = NOW()
      WHERE id = ${id}
    `;
    return { id, status: "Failed", error: message };
  }
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((token) => token.length >= 3 && !["the", "and", "payment", "purchase", "card"].includes(token)),
  );
}

function merchantSimilarity(receiptMerchant: string, transactionMerchant: string): number {
  const left = tokenSet(receiptMerchant);
  const right = tokenSet(transactionMerchant);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

export async function refreshReceiptMatches(business?: Business) {
  await ensureExpenseControlSchema();
  const businesses: Business[] = business ? [business] : ["Corner Deli", "Tiki"];
  const summary: Record<string, unknown> = {};

  for (const activeBusiness of businesses) {
    const receipts = await getSql()`
      SELECT r.* FROM receipt_documents r
      LEFT JOIN receipt_transaction_matches m ON m.receipt_id = r.id AND m.status <> 'Ignored'
      WHERE r.business = ${activeBusiness}
        AND r.ocr_status = 'Processed'
        AND r.total_amount IS NOT NULL
        AND m.id IS NULL
      ORDER BY COALESCE(r.receipt_date, r.created_at::date) DESC
      LIMIT 300
    ` as unknown as ReceiptRow[];
    const transactions = await getSql()`
      SELECT t.id, t.business, t.external_account_id, t.transaction_date, t.merchant_name,
        t.description, t.signed_amount, t.direction, a.account_type, a.account_subtype,
        a.name AS account_name
      FROM bank_transactions t
      JOIN bank_accounts a ON a.external_account_id = t.external_account_id
      LEFT JOIN receipt_transaction_matches m ON m.bank_transaction_id = t.id AND m.status = 'Matched'
      WHERE t.business = ${activeBusiness}
        AND t.pending = FALSE AND t.removed = FALSE
        AND t.signed_amount < 0
        AND t.transaction_date >= CURRENT_DATE - INTERVAL '730 days'
        AND m.id IS NULL
    ` as unknown as BankTransactionRow[];

    let suggested = 0;
    let autoMatched = 0;
    for (const receipt of receipts) {
      const total = numberValue(receipt.total_amount);
      const receiptDate = receipt.receipt_date || receipt.created_at.slice(0, 10);
      const candidates = transactions
        .map((transaction) => {
          const variance = Math.abs(total - Math.abs(numberValue(transaction.signed_amount)));
          const dateDifference = daysApart(receiptDate, transaction.transaction_date);
          const merchantScore = merchantSimilarity(
            receipt.merchant_name,
            `${transaction.merchant_name} ${transaction.description}`,
          );
          const allowedVariance = Math.max(0.5, total * 0.02);
          const amountScore = variance <= 0.01 ? 0.62 : Math.max(0, 0.62 * (1 - variance / allowedVariance));
          const dateScore = dateDifference === 0 ? 0.23 : dateDifference <= 2 ? 0.18 : dateDifference <= 5 ? 0.1 : 0;
          const confidence = Math.max(0, Math.min(1, amountScore + dateScore + merchantScore * 0.15));
          return { transaction, variance, dateDifference, merchantScore, confidence, allowedVariance };
        })
        .filter((candidate) => candidate.variance <= candidate.allowedVariance && candidate.dateDifference <= 7)
        .sort((left, right) => right.confidence - left.confidence);
      const best = candidates[0];
      if (!best || best.confidence < 0.7) continue;
      const uniqueHighConfidence = best.confidence >= 0.94
        && (!candidates[1] || best.confidence - candidates[1].confidence >= 0.1);
      const status = uniqueHighConfidence ? "Matched" : "Suggested";
      const inserted = await getSql()`
        INSERT INTO receipt_transaction_matches (
          id, receipt_id, bank_transaction_id, business, confidence,
          amount_variance, date_difference, merchant_score, status, matched_by, matched_at
        ) VALUES (
          ${crypto.randomUUID()}, ${receipt.id}, ${best.transaction.id}, ${activeBusiness}, ${best.confidence},
          ${roundMoney(best.variance)}, ${best.dateDifference}, ${best.merchantScore}, ${status},
          ${uniqueHighConfidence ? "Automatic receipt matcher" : ""}, ${uniqueHighConfidence ? new Date().toISOString() : null}
        )
        ON CONFLICT (receipt_id, bank_transaction_id) DO UPDATE SET
          confidence = EXCLUDED.confidence,
          amount_variance = EXCLUDED.amount_variance,
          date_difference = EXCLUDED.date_difference,
          merchant_score = EXCLUDED.merchant_score,
          updated_at = NOW()
        RETURNING status
      ` as unknown as Array<{ status: string }>;
      if (inserted[0]?.status === "Matched") autoMatched += 1;
      else if (inserted[0]?.status === "Suggested") suggested += 1;
    }
    summary[activeBusiness] = { receipts: receipts.length, transactions: transactions.length, suggested, autoMatched };
  }
  return summary;
}

export async function reviewReceiptMatch(input: {
  id: string;
  business: Business;
  accept: boolean;
  actor: string;
}) {
  await ensureExpenseControlSchema();
  const rows = await getSql()`
    SELECT id FROM receipt_transaction_matches WHERE id = ${input.id} AND business = ${input.business} LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Receipt match was not found.");
  await getSql()`
    UPDATE receipt_transaction_matches SET
      status = ${input.accept ? "Matched" : "Ignored"},
      matched_by = ${clean(input.actor, 255)},
      matched_at = ${input.accept ? new Date().toISOString() : null},
      updated_at = NOW()
    WHERE id = ${input.id}
  `;
  return { id: input.id, status: input.accept ? "Matched" : "Ignored" };
}

async function driveFilesInFolder(folderId: string) {
  const files: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
  }> = [];
  const folders = [folderId];
  const visited = new Set<string>();
  while (folders.length) {
    const active = folders.shift()!;
    if (visited.has(active)) continue;
    visited.add(active);
    let pageToken = "";
    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", `'${active.replaceAll("'", "\\'")}' in parents and trashed = false`);
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await googleJson<{
        nextPageToken?: string;
        files?: Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; webViewLink?: string }>;
      }>(url.toString());
      for (const file of page.files || []) {
        if (file.mimeType === "application/vnd.google-apps.folder") folders.push(file.id);
        else files.push(file);
      }
      pageToken = page.nextPageToken || "";
    } while (pageToken);
  }
  return files;
}

async function downloadDriveFile(fileId: string): Promise<ArrayBuffer> {
  const token = await googleAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Google Drive download failed (${response.status}).`);
  return response.arrayBuffer();
}

export async function syncReceiptDriveFolder(business: Business) {
  await ensureExpenseControlSchema();
  const folderId = driveFolder(business);
  if (!folderId) return { skipped: true, reason: `Google Drive receipt folder is not configured for ${business}.` };
  if (!googleConfigured()) return { skipped: true, reason: "Google service-account credentials are not configured." };

  const files = await driveFilesInFolder(folderId);
  let processed = 0;
  let unchanged = 0;
  let unsupported = 0;
  const errors: string[] = [];
  for (const file of files) {
    if (!supportedReceiptMimeType(file.mimeType)) {
      unsupported += 1;
      continue;
    }
    const sourceKey = `drive:${file.id}:${file.modifiedTime || "unknown"}`;
    const existing = await getSql()`
      SELECT id FROM receipt_documents WHERE source_key = ${sourceKey} LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (existing[0]) {
      unchanged += 1;
      continue;
    }
    try {
      const bytes = await downloadDriveFile(file.id);
      await ingestReceipt({
        business,
        source: "Google Drive",
        sourceKey,
        externalFileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: Number(file.size || bytes.byteLength),
        sourceUrl: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
        modifiedAtSource: file.modifiedTime || null,
        bytes,
        actor: "Google Drive folder monitor",
      });
      processed += 1;
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files: files.length, processed, unchanged, unsupported, errors };
}

export async function syncAllReceiptFolders() {
  return {
    cornerDeli: await syncReceiptDriveFolder("Corner Deli"),
    tiki: await syncReceiptDriveFolder("Tiki"),
  };
}

function mapReceipt(row: ReceiptRow) {
  return {
    id: row.id,
    business: row.business,
    source: row.source,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    sourceUrl: row.source_url,
    storageUrl: row.storage_url,
    ocrStatus: row.ocr_status,
    merchantName: row.merchant_name,
    receiptDate: row.receipt_date,
    totalAmount: row.total_amount === null ? null : numberValue(row.total_amount),
    taxAmount: row.tax_amount === null ? null : numberValue(row.tax_amount),
    currency: row.currency,
    ocrError: row.ocr_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function expenseControlDashboard(business: Business) {
  await ensureExpenseControlSchema();
  const accounts = await getSql()`
    SELECT a.id, a.institution_name, a.name, a.official_name, a.mask, a.account_type,
      a.account_subtype, a.current_balance, a.available_balance, a.currency, a.active,
      c.last_sync_at, c.status
    FROM bank_accounts a
    JOIN integration_connections c ON c.id = a.connection_id
    WHERE a.business = ${business}
    ORDER BY CASE WHEN a.account_type = 'credit' THEN 0 ELSE 1 END, a.institution_name, a.name
  ` as unknown as Array<Record<string, unknown>>;
  const transfers = await getSql()`
    SELECT m.id, m.amount, m.date_difference, m.confidence, m.status,
      bank.transaction_date AS bank_date, bank.merchant_name AS bank_merchant,
      bank.description AS bank_description, bank_account.name AS bank_account,
      card.transaction_date AS card_date, card.merchant_name AS card_merchant,
      card.description AS card_description, card_account.name AS card_account
    FROM credit_card_transfer_matches m
    JOIN bank_transactions bank ON bank.id = m.bank_transaction_id
    JOIN bank_transactions card ON card.id = m.card_transaction_id
    JOIN bank_accounts bank_account ON bank_account.external_account_id = bank.external_account_id
    JOIN bank_accounts card_account ON card_account.external_account_id = card.external_account_id
    WHERE m.business = ${business}
    ORDER BY CASE m.status WHEN 'Suggested' THEN 0 WHEN 'Matched' THEN 1 ELSE 2 END,
      GREATEST(bank.transaction_date, card.transaction_date) DESC
    LIMIT 200
  ` as unknown as Array<Record<string, unknown>>;
  const receipts = await getSql()`
    SELECT * FROM receipt_documents WHERE business = ${business}
    ORDER BY CASE ocr_status WHEN 'Failed' THEN 0 WHEN 'Needs Configuration' THEN 1 WHEN 'Processed' THEN 2 ELSE 3 END,
      COALESCE(receipt_date, created_at::date) DESC
    LIMIT 300
  ` as unknown as ReceiptRow[];
  const receiptMatches = await getSql()`
    SELECT m.id, m.receipt_id, m.bank_transaction_id, m.confidence, m.amount_variance,
      m.date_difference, m.merchant_score, m.status,
      r.file_name, r.merchant_name AS receipt_merchant, r.receipt_date, r.total_amount,
      t.transaction_date, t.merchant_name AS transaction_merchant, t.description,
      t.signed_amount, a.name AS account_name, a.account_type
    FROM receipt_transaction_matches m
    JOIN receipt_documents r ON r.id = m.receipt_id
    JOIN bank_transactions t ON t.id = m.bank_transaction_id
    JOIN bank_accounts a ON a.external_account_id = t.external_account_id
    WHERE m.business = ${business}
    ORDER BY CASE m.status WHEN 'Suggested' THEN 0 WHEN 'Matched' THEN 1 ELSE 2 END,
      COALESCE(r.receipt_date, r.created_at::date) DESC
    LIMIT 300
  ` as unknown as Array<Record<string, unknown>>;

  return {
    business,
    configuration: {
      plaid: Boolean(process.env.PLAID_CLIENT_ID?.trim() && process.env.PLAID_SECRET?.trim()),
      googleServiceAccount: googleConfigured(),
      documentAi: documentAiConfigured(),
      driveFolderConfigured: Boolean(driveFolder(business)),
      driveFolderId: driveFolder(business) ? "Configured" : "Missing",
    },
    counts: {
      bankAccounts: accounts.filter((account) => account.account_type !== "credit").length,
      creditCards: accounts.filter((account) => account.account_type === "credit").length,
      suggestedTransfers: transfers.filter((match) => match.status === "Suggested").length,
      processedReceipts: receipts.filter((receipt) => receipt.ocr_status === "Processed").length,
      receiptFailures: receipts.filter((receipt) => receipt.ocr_status === "Failed").length,
      suggestedReceiptMatches: receiptMatches.filter((match) => match.status === "Suggested").length,
      matchedReceipts: receiptMatches.filter((match) => match.status === "Matched").length,
    },
    accounts: accounts.map((account) => ({
      id: String(account.id),
      institutionName: String(account.institution_name),
      name: String(account.name),
      officialName: String(account.official_name || ""),
      mask: String(account.mask || ""),
      accountType: String(account.account_type || ""),
      accountSubtype: String(account.account_subtype || ""),
      currentBalance: account.current_balance === null ? null : numberValue(account.current_balance),
      availableBalance: account.available_balance === null ? null : numberValue(account.available_balance),
      currency: String(account.currency || "USD"),
      active: Boolean(account.active),
      lastSyncAt: account.last_sync_at || null,
      connectionStatus: String(account.status || ""),
    })),
    transfers: transfers.map((match) => ({
      id: String(match.id),
      amount: numberValue(match.amount),
      dateDifference: Number(match.date_difference || 0),
      confidence: numberValue(match.confidence),
      status: String(match.status),
      bankDate: String(match.bank_date),
      bankMerchant: String(match.bank_merchant || match.bank_description || "Bank payment"),
      bankAccount: String(match.bank_account),
      cardDate: String(match.card_date),
      cardMerchant: String(match.card_merchant || match.card_description || "Card credit"),
      cardAccount: String(match.card_account),
    })),
    receipts: receipts.map(mapReceipt),
    receiptMatches: receiptMatches.map((match) => ({
      id: String(match.id),
      receiptId: String(match.receipt_id),
      transactionId: String(match.bank_transaction_id),
      confidence: numberValue(match.confidence),
      amountVariance: numberValue(match.amount_variance),
      dateDifference: Number(match.date_difference || 0),
      merchantScore: numberValue(match.merchant_score),
      status: String(match.status),
      fileName: String(match.file_name),
      receiptMerchant: String(match.receipt_merchant || ""),
      receiptDate: match.receipt_date ? String(match.receipt_date) : null,
      totalAmount: numberValue(match.total_amount),
      transactionDate: String(match.transaction_date),
      transactionMerchant: String(match.transaction_merchant || match.description || ""),
      transactionAmount: Math.abs(numberValue(match.signed_amount)),
      accountName: String(match.account_name),
      accountType: String(match.account_type),
    })),
  };
}

export async function runExpenseAutomation() {
  await ensureExpenseControlSchema();
  return {
    drive: await syncAllReceiptFolders(),
    cardPayments: await refreshCreditCardPaymentMatches(),
    receipts: await refreshReceiptMatches(),
  };
}
