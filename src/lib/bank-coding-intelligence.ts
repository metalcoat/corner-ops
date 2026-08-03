import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { getSql } from "@/lib/db";
import { codeBankTransaction } from "@/lib/receivables";
import type { Business } from "@/lib/types";

type RuleRow = {
  direction: "Any" | "Inflow" | "Outflow";
  field: "Merchant" | "Description" | "Either";
  match_type: "Contains" | "Exact";
  pattern: string;
  category: string;
  account_code: string;
  confidence: string | number;
};

type TransactionRow = {
  id: string;
  transaction_date: string;
  merchant_name: string;
  description: string;
  signed_amount: string | number;
  direction: "Inflow" | "Outflow";
  pending: boolean;
  category: string;
  account_code: string;
  classification_source: string;
  confidence: string | number;
};

type HistoryRow = TransactionRow & {
  posted_at: string;
};

type Candidate = {
  accountCode: string;
  category: string;
  confidence: number;
  source: string;
  evidenceCount: number;
};

export type BankCodingSuggestion = {
  id: string;
  transactionDate: string;
  merchantName: string;
  description: string;
  signedAmount: number;
  direction: "Inflow" | "Outflow";
  pending: boolean;
  accountCode: string;
  accountName: string;
  category: string;
  confidence: number;
  confidencePercent: number;
  confidenceBand: "High" | "Medium" | "Low" | "None";
  source: string;
  evidenceCount: number;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalized(value: unknown): string {
  return clean(value, 300).toLowerCase().replace(/\b(?:pos|purchase|debit|credit|payment|online|card)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function transactionKeys(row: Pick<TransactionRow, "merchant_name" | "description" | "direction">): string[] {
  const merchant = normalized(row.merchant_name);
  const description = normalized(row.description);
  const result = new Set<string>();
  if (merchant) result.add(`${row.direction}:merchant:${merchant}`);
  if (description) result.add(`${row.direction}:description:${description}`);
  return [...result];
}

function ruleMatches(rule: RuleRow, row: TransactionRow): boolean {
  if (rule.direction !== "Any" && rule.direction !== row.direction) return false;
  const pattern = normalized(rule.pattern);
  if (!pattern) return false;
  const merchant = normalized(row.merchant_name);
  const description = normalized(row.description);
  const values = rule.field === "Merchant" ? [merchant] : rule.field === "Description" ? [description] : [merchant, description];
  return values.some((value) => rule.match_type === "Exact" ? value === pattern : value.includes(pattern));
}

function confidenceBand(value: number): BankCodingSuggestion["confidenceBand"] {
  if (value >= 0.9) return "High";
  if (value >= 0.75) return "Medium";
  if (value > 0) return "Low";
  return "None";
}

function historyCandidates(history: HistoryRow[]) {
  const map = new Map<string, Array<{ accountCode: string; category: string }>>();
  for (const row of history) {
    if (!row.account_code || row.account_code === "1200") continue;
    for (const key of transactionKeys(row)) {
      const list = map.get(key) || [];
      list.push({ accountCode: row.account_code, category: row.category });
      map.set(key, list);
    }
  }
  return map;
}

function learnedCandidate(row: TransactionRow, examples: ReturnType<typeof historyCandidates>): Candidate | null {
  const votes = new Map<string, { count: number; category: string }>();
  for (const key of transactionKeys(row)) {
    for (const example of examples.get(key) || []) {
      const current = votes.get(example.accountCode) || { count: 0, category: example.category };
      current.count += 1;
      if (example.category) current.category = example.category;
      votes.set(example.accountCode, current);
    }
  }
  const ranked = [...votes.entries()].sort((left, right) => right[1].count - left[1].count);
  const winner = ranked[0];
  if (!winner) return null;
  const total = ranked.reduce((sum, item) => sum + item[1].count, 0);
  const consistency = winner[1].count / Math.max(1, total);
  const sampleConfidence = winner[1].count >= 5 ? 0.97
    : winner[1].count === 4 ? 0.95
      : winner[1].count === 3 ? 0.92
        : winner[1].count === 2 ? 0.86
          : 0.72;
  return {
    accountCode: winner[0],
    category: winner[1].category,
    confidence: Math.min(0.99, sampleConfidence * consistency),
    source: `Learned from ${winner[1].count} matching coded transaction${winner[1].count === 1 ? "" : "s"}`,
    evidenceCount: winner[1].count,
  };
}

async function buildSuggestions(business: Business) {
  await ensureAccountingControlSchema();
  const sql = getSql();
  const [accountRows, transactionRows, ruleRows, historyRows] = await Promise.all([
    sql`
      SELECT code, name FROM accounting_accounts
      WHERE business = ${business} AND active = TRUE
      ORDER BY code
    `,
    sql`
      SELECT t.id, t.transaction_date, t.merchant_name, t.description, t.signed_amount,
        t.direction, t.pending, t.category, t.account_code, t.classification_source, t.confidence
      FROM bank_transactions t
      LEFT JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
      WHERE t.business = ${business} AND t.removed = FALSE AND p.id IS NULL
      ORDER BY t.transaction_date DESC, t.created_at DESC
      LIMIT 500
    `,
    sql`
      SELECT direction, field, match_type, pattern, category, account_code, confidence
      FROM classification_rules
      WHERE business = ${business} AND active = TRUE
      ORDER BY priority, created_at
    `,
    sql`
      SELECT t.id, t.transaction_date, t.merchant_name, t.description, t.signed_amount,
        t.direction, t.pending, t.category, t.account_code, t.classification_source,
        t.confidence, p.posted_at
      FROM bank_transactions t
      JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
      WHERE t.business = ${business} AND t.removed = FALSE
        AND t.account_code <> '' AND t.account_code <> '1200'
      ORDER BY p.posted_at DESC
      LIMIT 1000
    `,
  ]);

  const accounts = new Map((accountRows as unknown as Array<{ code: string; name: string }>).map((row) => [row.code, row.name]));
  const rules = ruleRows as unknown as RuleRow[];
  const history = historyRows as unknown as HistoryRow[];
  const examples = historyCandidates(history);

  const suggestions = (transactionRows as unknown as TransactionRow[]).map((row): BankCodingSuggestion => {
    const candidates: Candidate[] = [];
    const rule = rules.find((item) => ruleMatches(item, row));
    if (rule && accounts.has(rule.account_code) && rule.account_code !== "1200") {
      candidates.push({
        accountCode: rule.account_code,
        category: rule.category,
        confidence: Math.max(0, Math.min(1, numeric(rule.confidence))),
        source: `Saved rule: ${rule.pattern}`,
        evidenceCount: 1,
      });
    }

    const learned = learnedCandidate(row, examples);
    if (learned && accounts.has(learned.accountCode)) candidates.push(learned);

    const importedConfidence = Math.max(0, Math.min(1, numeric(row.confidence)));
    if (row.account_code && accounts.has(row.account_code) && row.account_code !== "1200" && importedConfidence > 0) {
      candidates.push({
        accountCode: row.account_code,
        category: row.category,
        confidence: importedConfidence,
        source: row.classification_source || "Imported bank category",
        evidenceCount: 0,
      });
    }

    candidates.sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount);
    const selected = candidates[0] || { accountCode: "", category: "", confidence: 0, source: "No reliable match yet", evidenceCount: 0 };
    return {
      id: row.id,
      transactionDate: String(row.transaction_date).slice(0, 10),
      merchantName: row.merchant_name,
      description: row.description,
      signedAmount: numeric(row.signed_amount),
      direction: row.direction,
      pending: Boolean(row.pending),
      accountCode: selected.accountCode,
      accountName: accounts.get(selected.accountCode) || "",
      category: selected.category,
      confidence: selected.confidence,
      confidencePercent: Math.round(selected.confidence * 100),
      confidenceBand: confidenceBand(selected.confidence),
      source: selected.source,
      evidenceCount: selected.evidenceCount,
    };
  });

  return { suggestions, rules: rules.length, learnedExamples: history.length };
}

export async function bankCodingIntelligence(business: Business) {
  const result = await buildSuggestions(business);
  const ready = result.suggestions.filter((item) => !item.pending && item.accountCode);
  return {
    business,
    summary: {
      totalUnposted: result.suggestions.length,
      highConfidence: ready.filter((item) => item.confidence >= 0.9).length,
      mediumConfidence: ready.filter((item) => item.confidence >= 0.75 && item.confidence < 0.9).length,
      lowConfidence: ready.filter((item) => item.confidence > 0 && item.confidence < 0.75).length,
      noSuggestion: result.suggestions.filter((item) => !item.accountCode).length,
      savedRules: result.rules,
      learnedExamples: result.learnedExamples,
    },
    suggestions: result.suggestions,
  };
}

export async function applyBankCodingSuggestions(input: {
  business: Business;
  minimumConfidence: number;
  transactionIds?: string[];
  actor: string;
}) {
  const threshold = Math.max(0.75, Math.min(1, Number(input.minimumConfidence || 0.9)));
  const requestedIds = new Set((input.transactionIds || []).map(String).filter(Boolean));
  const result = await buildSuggestions(input.business);
  const selected = result.suggestions.filter((suggestion) =>
    !suggestion.pending
    && Boolean(suggestion.accountCode)
    && suggestion.accountCode !== "1200"
    && suggestion.confidence >= threshold
    && (requestedIds.size === 0 || requestedIds.has(suggestion.id)),
  ).slice(0, 100);

  const outcomes: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const suggestion of selected) {
    try {
      await codeBankTransaction({
        business: input.business,
        transactionId: suggestion.id,
        lines: [{
          accountCode: suggestion.accountCode,
          amount: Math.abs(suggestion.signedAmount),
          memo: `Approved coding suggestion (${suggestion.confidencePercent}%): ${suggestion.source}`,
        }],
        teach: false,
        actor: input.actor,
      });
      outcomes.push({ id: suggestion.id, ok: true });
    } catch (error) {
      outcomes.push({ id: suggestion.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    threshold,
    attempted: selected.length,
    coded: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
  };
}
