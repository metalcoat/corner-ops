import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { getSql } from "@/lib/db";
import { ensureIntegrationSchema } from "@/lib/integrations";
import type { Business } from "@/lib/types";

type ClassificationRule = {
  priority: number;
  direction: string;
  field: "Merchant" | "Description" | "Either";
  match_type: "Contains" | "Exact";
  pattern: string;
  category: string;
  account_code: string;
  confidence: string | number;
};

type ParsedBankRow = {
  date: string;
  description: string;
  merchant: string;
  checkNumber: string;
  accountName: string;
  signedAmount: number;
  balance: number | null;
  pending: boolean;
  raw: Record<string, unknown>;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function slug(value: string): string {
  return clean(value, 160).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

function parseMoney(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const source = String(value ?? "").trim();
  if (!source) return 0;
  const negative = /^\s*\(/.test(source)
    || /^\s*-/.test(source)
    || /-\s*$/.test(source)
    || /\bDR\b/i.test(source);
  const numeric = Number(source.replace(/[,$()%\s]/g, "").replace(/\b(?:CR|DR)\b/gi, "").replace(/-+$/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((negative ? -Math.abs(numeric) : numeric) * 100) / 100;
}

function parseDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const text = clean(value, 80);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
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

function normalizedText(value: unknown): string {
  return clean(value, 500).toLowerCase().replace(/\b(?:deposit|withdrawal|purchase|payment|debit|credit|pending)\b/g, "").replace(/[^a-z0-9]+/g, "");
}

function merchantFromDescription(description: string): string {
  const firstLine = description.split(/\r?\n/)[0] || description;
  return clean(firstLine.replace(/^(?:deposit|withdrawal|purchase|payment|debit|credit)\s+/i, ""), 240);
}

function formatName(headers: string[]): string {
  const keys = new Set(headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (keys.has("account") && keys.has("check") && keys.has("balance")) return "SEACOMM transaction history";
  if (keys.has("comments") && keys.has("checknumber") && keys.has("balance")) return "NBT transaction export";
  return "Generic bank export";
}

function parseRows(rows: Record<string, unknown>[], fallbackAccountName: string): ParsedBankRow[] {
  return rows.flatMap((row) => {
    const date = parseDate(rowValue(row, ["Date", "Transaction Date", "Posted Date", "Posting Date"]));
    const rawDescription = String(rowValue(row, ["Description", "Memo", "Details", "Transaction", "Name"]) || "").trim();
    const comments = String(rowValue(row, ["Comments", "Comment", "Note"]) || "").trim();
    const description = clean([rawDescription, comments && comments !== rawDescription ? comments : ""].filter(Boolean).join(" | "), 800);
    if (!date || !description) return [];

    const debit = Math.abs(parseMoney(rowValue(row, ["Debit", "Withdrawal", "Amount Debited", "Charge"]))) || 0;
    const credit = Math.abs(parseMoney(rowValue(row, ["Credit", "Deposit", "Amount Credited"]))) || 0;
    const rawAmount = parseMoney(rowValue(row, ["Amount", "Transaction Amount", "Signed Amount"]));
    const signedAmount = credit ? credit : debit ? -debit : rawAmount;
    if (!signedAmount) return [];

    return [{
      date,
      description,
      merchant: merchantFromDescription(rawDescription || description),
      checkNumber: clean(rowValue(row, ["Check #", "Check Number", "Check No", "Check"]), 50),
      accountName: clean(rowValue(row, ["Account", "Account Name"]), 160) || fallbackAccountName,
      signedAmount,
      balance: rowValue(row, ["Balance", "Running Balance"]) === "" ? null : parseMoney(rowValue(row, ["Balance", "Running Balance"])),
      pending: /\bpending\b/i.test(description),
      raw: row,
    }];
  });
}

function fallbackClassification(business: Business, merchant: string, description: string, signedAmount: number) {
  const text = `${merchant} ${description}`.toLowerCase();
  const direction = signedAmount < 0 ? "Outflow" : "Inflow";
  let category = direction === "Inflow" ? "Sales / Income" : "Other Expense";
  let accountCode = direction === "Inflow" ? (business === "Tiki" ? "4100" : "4000") : "5900";
  let confidence = direction === "Inflow" ? 0.6 : 0.55;

  if (/bank fee|overdraft|service charge|atm fee/.test(text)) {
    category = "Bank Fees";
    accountCode = "5700";
    confidence = 0.9;
  } else if (/payroll|paychex|gusto|adp|tax debit|nys dol|nys dtf/.test(text)) {
    category = "Payroll";
    accountCode = "5100";
    confidence = 0.82;
  } else if (/national grid|utility|utilities|water|electric|gas bill/.test(text)) {
    category = "Utilities";
    accountCode = "5300";
    confidence = 0.78;
  } else if (/us food|sysco|restaurant depot|grocery|foodservice/.test(text)) {
    category = "Cost of Goods Sold";
    accountCode = "5000";
    confidence = 0.82;
  } else if (/transfer|xfer|online transfer/.test(text)) {
    category = "Bank Clearing / Transfer";
    accountCode = "1100";
    confidence = 0.75;
  }
  return { direction, category, accountCode, confidence, source: "Historical import rule" };
}

function classify(rules: ClassificationRule[], business: Business, row: ParsedBankRow) {
  const fallback = fallbackClassification(business, row.merchant, row.description, row.signedAmount);
  const merchant = row.merchant.toLowerCase();
  const description = row.description.toLowerCase();
  const rule = rules.find((candidate) => {
    if (candidate.direction !== "Any" && candidate.direction !== fallback.direction) return false;
    const pattern = candidate.pattern.toLowerCase();
    const values = candidate.field === "Merchant" ? [merchant] : candidate.field === "Description" ? [description] : [merchant, description];
    return values.some((value) => candidate.match_type === "Exact" ? value === pattern : value.includes(pattern));
  });
  if (!rule) return fallback;
  return {
    direction: fallback.direction,
    category: rule.category,
    accountCode: rule.account_code,
    confidence: Number(rule.confidence || 0),
    source: `Rule: ${rule.pattern}`,
  };
}

async function strongExistingMatch(input: {
  business: Business;
  connectionId: string;
  row: ParsedBankRow;
}) {
  const candidates = await getSql()`
    SELECT t.id, t.merchant_name, t.description, t.check_number
    FROM bank_transactions t
    WHERE t.business = ${input.business}
      AND t.connection_id <> ${input.connectionId}
      AND t.transaction_date = ${input.row.date}
      AND t.signed_amount = ${input.row.signedAmount}
      AND t.removed = FALSE
    LIMIT 20
  ` as unknown as Array<{ id: string; merchant_name: string; description: string; check_number: string }>;
  const target = normalizedText(input.row.merchant || input.row.description);
  return candidates.find((candidate) => {
    if (input.row.checkNumber && candidate.check_number && input.row.checkNumber === candidate.check_number) return true;
    const candidateText = normalizedText(candidate.merchant_name || candidate.description);
    return target.length >= 10 && candidateText === target;
  }) || null;
}

export async function importHistoricalBankFile(input: {
  business: Business;
  institutionName: string;
  accountName?: string;
  fileName: string;
  bytes: ArrayBuffer;
  actor: string;
}) {
  await ensureIntegrationSchema();
  const workbook = XLSX.read(Buffer.from(input.bytes), { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The bank file did not contain a readable worksheet.");
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, dateNF: "yyyy-mm-dd" }) as Record<string, unknown>[];
  if (!rawRows.length) throw new Error("The bank file did not contain transaction rows.");

  const headers = Object.keys(rawRows[0] || {});
  const detectedFormat = formatName(headers);
  const institution = clean(input.institutionName, 120) || "Imported bank";
  const fallbackAccountName = clean(input.accountName, 160) || (input.business === "Tiki" ? "At The Docks operating" : "Business Account");
  const parsedRows = parseRows(rawRows, fallbackAccountName);
  if (!parsedRows.length) throw new Error("No dated transaction rows with non-zero amounts were found.");

  const accountNames = [...new Set(parsedRows.map((row) => row.accountName || fallbackAccountName))];
  const connectionKey = `historical:${input.business}:${slug(institution)}:${slug(accountNames.join("-"))}`;
  const connectionRows = await getSql()`
    INSERT INTO integration_connections (id, provider, business, institution_name, external_item_id, metadata)
    VALUES (
      ${crypto.randomUUID()}, 'CSV', ${input.business}, ${institution}, ${connectionKey},
      ${JSON.stringify({ lastFile: input.fileName, actor: input.actor, detectedFormat, accountNames })}::jsonb
    )
    ON CONFLICT (provider, external_item_id) DO UPDATE SET
      institution_name = EXCLUDED.institution_name,
      metadata = EXCLUDED.metadata,
      status = 'Active',
      updated_at = NOW()
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  const connectionId = connectionRows[0].id;

  for (const accountName of accountNames) {
    const latestWithBalance = parsedRows.find((row) => row.accountName === accountName && row.balance !== null);
    const externalAccountId = `historical-account:${createHash("sha256").update(`${connectionKey}|${accountName}`).digest("hex")}`;
    await getSql()`
      INSERT INTO bank_accounts (
        id, connection_id, business, external_account_id, institution_name, name, official_name,
        account_type, account_subtype, current_balance, currency, active
      ) VALUES (
        ${crypto.randomUUID()}, ${connectionId}, ${input.business}, ${externalAccountId}, ${institution},
        ${accountName}, ${accountName}, 'depository', 'checking', ${latestWithBalance?.balance ?? null}, 'USD', TRUE
      )
      ON CONFLICT (external_account_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id,
        institution_name = EXCLUDED.institution_name,
        name = EXCLUDED.name,
        official_name = EXCLUDED.official_name,
        current_balance = EXCLUDED.current_balance,
        active = TRUE,
        updated_at = NOW()
    `;
  }

  const rules = await getSql()`
    SELECT priority, direction, field, match_type, pattern, category, account_code, confidence
    FROM classification_rules
    WHERE business = ${input.business} AND active = TRUE
    ORDER BY priority ASC, created_at ASC
  ` as unknown as ClassificationRule[];

  const occurrence = new Map<string, number>();
  let imported = 0;
  let updated = 0;
  let matchedExisting = 0;
  let skipped = 0;
  let inflows = 0;
  let outflows = 0;

  for (const row of parsedRows) {
    const normalized = normalizedText(row.description);
    const baseKey = `${row.accountName}|${row.date}|${row.signedAmount.toFixed(2)}|${normalized}|${row.checkNumber}`;
    const ordinal = (occurrence.get(baseKey) || 0) + 1;
    occurrence.set(baseKey, ordinal);
    const externalTransactionId = `historical:${createHash("sha256").update(`${connectionKey}|${baseKey}|${ordinal}`).digest("hex")}`;

    const existing = await strongExistingMatch({ business: input.business, connectionId, row });
    if (existing) {
      matchedExisting += 1;
      continue;
    }

    const classification = classify(rules, input.business, row);
    const reviewStatus = classification.confidence >= 0.9 ? "Approved" : "Needs Review";
    const result = await getSql()`
      INSERT INTO bank_transactions (
        id, connection_id, business, external_transaction_id, external_account_id,
        transaction_date, merchant_name, description, signed_amount, direction, pending,
        category, account_code, classification_source, confidence, review_status,
        check_number, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${connectionId}, ${input.business}, ${externalTransactionId},
        ${`historical-account:${createHash("sha256").update(`${connectionKey}|${row.accountName}`).digest("hex")}`},
        ${row.date}, ${row.merchant}, ${row.description}, ${row.signedAmount}, ${classification.direction},
        ${row.pending}, ${classification.category}, ${classification.accountCode}, ${classification.source},
        ${classification.confidence}, ${reviewStatus}, ${row.checkNumber},
        ${JSON.stringify({ source: "Historical file", format: detectedFormat, accountName: row.accountName, balance: row.balance, row: row.raw })}::jsonb
      )
      ON CONFLICT (external_transaction_id) DO UPDATE SET
        merchant_name = EXCLUDED.merchant_name,
        description = EXCLUDED.description,
        signed_amount = EXCLUDED.signed_amount,
        direction = EXCLUDED.direction,
        pending = EXCLUDED.pending,
        category = CASE WHEN bank_transactions.user_override THEN bank_transactions.category ELSE EXCLUDED.category END,
        account_code = CASE WHEN bank_transactions.user_override THEN bank_transactions.account_code ELSE EXCLUDED.account_code END,
        classification_source = CASE WHEN bank_transactions.user_override THEN bank_transactions.classification_source ELSE EXCLUDED.classification_source END,
        confidence = CASE WHEN bank_transactions.user_override THEN bank_transactions.confidence ELSE EXCLUDED.confidence END,
        review_status = CASE WHEN bank_transactions.user_override THEN bank_transactions.review_status ELSE EXCLUDED.review_status END,
        check_number = EXCLUDED.check_number,
        raw = EXCLUDED.raw,
        removed = FALSE,
        updated_at = NOW()
      RETURNING (xmax = 0) AS inserted
    ` as unknown as Array<{ inserted: boolean }>;
    if (!result[0]) {
      skipped += 1;
    } else if (result[0].inserted) {
      imported += 1;
    } else {
      updated += 1;
    }
    if (row.signedAmount > 0) inflows += row.signedAmount;
    else outflows += row.signedAmount;
  }

  const dates = parsedRows.map((row) => row.date).sort();
  await getSql()`
    UPDATE integration_connections SET
      last_sync_at = NOW(),
      metadata = ${JSON.stringify({
        lastFile: input.fileName,
        actor: input.actor,
        detectedFormat,
        accountNames,
        rowsRead: rawRows.length,
        parsedRows: parsedRows.length,
        imported,
        updated,
        matchedExisting,
        dateFrom: dates[0],
        dateTo: dates[dates.length - 1],
      })}::jsonb,
      updated_at = NOW()
    WHERE id = ${connectionId}
  `;

  return {
    detectedFormat,
    rowsRead: rawRows.length,
    parsedRows: parsedRows.length,
    imported,
    updated,
    matchedExisting,
    skipped,
    accountNames,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    inflows: Math.round(inflows * 100) / 100,
    outflows: Math.round(outflows * 100) / 100,
  };
}
