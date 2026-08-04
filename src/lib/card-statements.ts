import * as XLSX from "xlsx";
import { getSql } from "@/lib/db";
import { ensureIntegrationSchema } from "@/lib/integrations";
import type { Business } from "@/lib/types";

const MAX_CANDIDATES = 5;
let statementSchemaPromise: Promise<void> | null = null;

type ParsedCardTransaction = {
  date: string;
  description: string;
  amount: number;
  raw: Record<string, unknown>;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function moneyValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  const source = String(value ?? "").trim();
  if (!source) return 0;
  const negative = /^\s*\(/.test(source) || /^\s*-/.test(source) || /-\s*$/.test(source) || /\bCR\b/i.test(source);
  const numeric = Number(source.replace(/[,$()%\s]/g, "").replace(/\b(?:CR|DR)\b/gi, "").replace(/-+$/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((negative ? -Math.abs(numeric) : numeric) * 100) / 100;
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const text = clean(value, 80);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (us) return `${us[3].length === 2 ? `20${us[3]}` : us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function rowValue(row: Record<string, unknown>, names: string[]): unknown {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function parseSpreadsheet(bytes: ArrayBuffer): ParsedCardTransaction[] {
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, dateNF: "yyyy-mm-dd" }) as Record<string, unknown>[];
  return rows.flatMap((row) => {
    const date = dateValue(rowValue(row, ["Date", "Transaction Date", "Posted Date", "Posting Date"]));
    const description = clean(rowValue(row, ["Description", "Merchant", "Payee", "Memo", "Details", "Transaction"]), 800);
    if (!date || !description) return [];
    const charge = Math.abs(moneyValue(rowValue(row, ["Charge", "Debit", "Purchase", "Amount Debited"]))) || 0;
    const credit = Math.abs(moneyValue(rowValue(row, ["Credit", "Payment", "Refund", "Amount Credited"]))) || 0;
    const rawAmount = moneyValue(rowValue(row, ["Amount", "Transaction Amount", "Signed Amount"]));
    const amount = charge ? charge : credit ? -credit : rawAmount;
    if (!amount) return [];
    return [{ date, description, amount, raw: row }];
  });
}

export function ensureCardStatementSchema(): Promise<void> {
  if (!statementSchemaPromise) {
    statementSchemaPromise = (async () => {
      await ensureIntegrationSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS credit_card_statements (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          issuer TEXT NOT NULL,
          account_name TEXT NOT NULL DEFAULT '',
          last_four TEXT NOT NULL DEFAULT '',
          statement_end_date DATE NOT NULL,
          statement_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
          payment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          blob_url TEXT NOT NULL UNIQUE,
          blob_pathname TEXT NOT NULL,
          extraction_status TEXT NOT NULL CHECK (extraction_status IN ('Document Only', 'Extracted', 'No Rows')),
          parsed_transaction_count INTEGER NOT NULL DEFAULT 0,
          parsed_total NUMERIC(14,2) NOT NULL DEFAULT 0,
          suggested_bank_transaction_id UUID REFERENCES bank_transactions(id) ON DELETE SET NULL,
          matched_bank_transaction_id UUID REFERENCES bank_transactions(id) ON DELETE SET NULL,
          match_status TEXT NOT NULL DEFAULT 'Unmatched' CHECK (match_status IN ('Unmatched', 'Suggested', 'Matched')),
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS credit_card_statements_business_date_idx ON credit_card_statements (business, statement_end_date DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS credit_card_statement_transactions (
          id UUID PRIMARY KEY,
          statement_id UUID NOT NULL REFERENCES credit_card_statements(id) ON DELETE CASCADE,
          transaction_date DATE NOT NULL,
          description TEXT NOT NULL,
          amount NUMERIC(14,2) NOT NULL,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS credit_card_statement_transactions_statement_idx ON credit_card_statement_transactions (statement_id, transaction_date)`;
    })().catch((error) => {
      statementSchemaPromise = null;
      throw error;
    });
  }
  return statementSchemaPromise;
}

async function paymentCandidates(business: Business, statementEndDate: string, paymentAmount: number) {
  if (paymentAmount <= 0) return [];
  return await getSql()`
    SELECT id, transaction_date, merchant_name, description, signed_amount,
      ABS(transaction_date - ${statementEndDate}::date) AS date_distance
    FROM bank_transactions
    WHERE business = ${business}
      AND removed = FALSE
      AND signed_amount = ${-Math.abs(paymentAmount)}
      AND transaction_date >= ${statementEndDate}::date - 10
      AND transaction_date <= ${statementEndDate}::date + 60
    ORDER BY date_distance, transaction_date
    LIMIT ${MAX_CANDIDATES}
  ` as unknown as Array<{
    id: string;
    transaction_date: string;
    merchant_name: string;
    description: string;
    signed_amount: number | string;
    date_distance: number | string;
  }>;
}

export async function createCardStatement(input: {
  business: Business;
  issuer: string;
  accountName?: string;
  lastFour?: string;
  statementEndDate: string;
  statementBalance: number;
  paymentAmount: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  blobUrl: string;
  blobPathname: string;
  bytes: ArrayBuffer;
  createdBy: string;
}) {
  await ensureCardStatementSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.statementEndDate)) throw new Error("Choose a valid statement ending date.");
  const issuer = clean(input.issuer, 160);
  if (!issuer) throw new Error("Card issuer or card name is required.");
  const extension = input.fileName.split(".").pop()?.toLowerCase() || "";
  const parsed = extension === "csv" || extension === "xls" || extension === "xlsx"
    ? parseSpreadsheet(input.bytes)
    : [];
  const extractionStatus = extension === "pdf" ? "Document Only" : parsed.length ? "Extracted" : "No Rows";
  const parsedTotal = Math.round(parsed.reduce((total, row) => total + row.amount, 0) * 100) / 100;
  const candidates = await paymentCandidates(input.business, input.statementEndDate, input.paymentAmount);
  const suggested = candidates[0]?.id || null;
  const id = crypto.randomUUID();

  await getSql()`
    INSERT INTO credit_card_statements (
      id, business, issuer, account_name, last_four, statement_end_date,
      statement_balance, payment_amount, file_name, content_type, size_bytes,
      blob_url, blob_pathname, extraction_status, parsed_transaction_count,
      parsed_total, suggested_bank_transaction_id, match_status, created_by
    ) VALUES (
      ${id}, ${input.business}, ${issuer}, ${clean(input.accountName, 160)}, ${clean(input.lastFour, 4)},
      ${input.statementEndDate}, ${Math.round(Number(input.statementBalance || 0) * 100) / 100},
      ${Math.round(Number(input.paymentAmount || 0) * 100) / 100}, ${clean(input.fileName, 255)},
      ${clean(input.contentType || "application/octet-stream", 160)}, ${input.sizeBytes},
      ${input.blobUrl}, ${input.blobPathname}, ${extractionStatus}, ${parsed.length}, ${parsedTotal},
      ${suggested}, ${suggested ? "Suggested" : "Unmatched"}, ${clean(input.createdBy, 240)}
    )
  `;

  for (const row of parsed) {
    await getSql()`
      INSERT INTO credit_card_statement_transactions (
        id, statement_id, transaction_date, description, amount, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${id}, ${row.date}, ${row.description}, ${row.amount}, ${JSON.stringify(row.raw)}::jsonb
      )
    `;
  }

  return {
    id,
    extractionStatus,
    parsedTransactionCount: parsed.length,
    parsedTotal,
    candidateCount: candidates.length,
    suggestedBankTransactionId: suggested,
  };
}

export async function cardStatementDashboard(business: Business) {
  await ensureCardStatementSchema();
  const statements = await getSql()`
    SELECT s.id, s.business, s.issuer, s.account_name, s.last_four, s.statement_end_date,
      s.statement_balance, s.payment_amount, s.file_name, s.content_type, s.size_bytes,
      s.extraction_status, s.parsed_transaction_count, s.parsed_total, s.match_status,
      s.suggested_bank_transaction_id, s.matched_bank_transaction_id, s.created_at,
      COALESCE(matched.transaction_date, suggested.transaction_date) AS bank_transaction_date,
      COALESCE(matched.merchant_name, suggested.merchant_name) AS bank_merchant_name,
      COALESCE(matched.description, suggested.description) AS bank_description,
      COALESCE(matched.signed_amount, suggested.signed_amount) AS bank_signed_amount
    FROM credit_card_statements s
    LEFT JOIN bank_transactions suggested ON suggested.id = s.suggested_bank_transaction_id
    LEFT JOIN bank_transactions matched ON matched.id = s.matched_bank_transaction_id
    WHERE s.business = ${business}
    ORDER BY s.statement_end_date DESC, s.created_at DESC
    LIMIT 100
  ` as unknown as Array<Record<string, unknown>>;

  const result = [];
  for (const row of statements) {
    const candidates = row.match_status === "Matched"
      ? []
      : await paymentCandidates(business, String(row.statement_end_date), Number(row.payment_amount || 0));
    result.push({
      id: String(row.id),
      business: row.business,
      issuer: row.issuer,
      accountName: row.account_name,
      lastFour: row.last_four,
      statementEndDate: row.statement_end_date,
      statementBalance: Number(row.statement_balance || 0),
      paymentAmount: Number(row.payment_amount || 0),
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes || 0),
      extractionStatus: row.extraction_status,
      parsedTransactionCount: Number(row.parsed_transaction_count || 0),
      parsedTotal: Number(row.parsed_total || 0),
      matchStatus: row.match_status,
      suggestedBankTransactionId: row.suggested_bank_transaction_id,
      matchedBankTransactionId: row.matched_bank_transaction_id,
      bankTransaction: row.bank_transaction_date ? {
        id: row.matched_bank_transaction_id || row.suggested_bank_transaction_id,
        date: row.bank_transaction_date,
        merchantName: row.bank_merchant_name,
        description: row.bank_description,
        amount: Number(row.bank_signed_amount || 0),
      } : null,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        date: candidate.transaction_date,
        merchantName: candidate.merchant_name,
        description: candidate.description,
        amount: Number(candidate.signed_amount || 0),
        dateDistance: Number(candidate.date_distance || 0),
      })),
      createdAt: row.created_at,
    });
  }
  return { statements: result };
}

export async function confirmCardStatementMatch(input: {
  business: Business;
  statementId: string;
  bankTransactionId: string;
}) {
  await ensureCardStatementSchema();
  const rows = await getSql()`
    SELECT s.id
    FROM credit_card_statements s
    JOIN bank_transactions t ON t.id = ${input.bankTransactionId} AND t.business = s.business
    WHERE s.id = ${input.statementId} AND s.business = ${input.business}
      AND t.signed_amount = -ABS(s.payment_amount)
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("The selected bank transaction does not match this statement payment amount.");
  await getSql()`
    UPDATE credit_card_statements SET
      matched_bank_transaction_id = ${input.bankTransactionId},
      suggested_bank_transaction_id = ${input.bankTransactionId},
      match_status = 'Matched',
      updated_at = NOW()
    WHERE id = ${input.statementId} AND business = ${input.business}
  `;
  return { matched: true };
}

export async function findCardStatementFile(id: string) {
  await ensureCardStatementSchema();
  const rows = await getSql()`
    SELECT id, business, file_name, content_type, blob_url
    FROM credit_card_statements WHERE id = ${id} LIMIT 1
  ` as unknown as Array<{
    id: string;
    business: Business;
    file_name: string;
    content_type: string;
    blob_url: string;
  }>;
  return rows[0] || null;
}
