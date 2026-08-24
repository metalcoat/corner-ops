import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { postFinancialTransaction } from "@/lib/bank-posting";
import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

let receivablesSchemaPromise: Promise<void> | null = null;

type Cadence = "Monthly" | "Quarterly" | "Annual";
type CodingLine = {
  accountCode?: string;
  invoiceId?: string;
  amount: number;
  memo?: string;
};

type TemplateRow = {
  id: string;
  business: Business;
  name: string;
  customer_name: string;
  description: string;
  amount: string | number;
  revenue_account_code: string;
  cadence: Cadence;
  due_days: number;
  next_issue_date: string;
  label_template: string;
  active: boolean;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoDate(value: unknown, label = "Date"): string {
  const text = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must be a valid date.`);
  return text;
}

function dateParts(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(value: string, months: number): string {
  const { year, month, day } = dateParts(value);
  const base = new Date(Date.UTC(year, month - 1 + months, 1));
  const nextYear = base.getUTCFullYear();
  const nextMonth = base.getUTCMonth() + 1;
  const nextDay = Math.min(day, lastDay(nextYear, nextMonth));
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`;
}

function advanceIssueDate(value: string, cadence: Cadence): string {
  if (cadence === "Quarterly") return addMonths(value, 3);
  if (cadence === "Annual") return addMonths(value, 12);
  return addMonths(value, 1);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodKey(issueDate: string, cadence: Cadence): string {
  const { year, month } = dateParts(issueDate);
  if (cadence === "Annual") return String(year);
  if (cadence === "Quarterly") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  return issueDate.slice(0, 7);
}

function periodLabel(issueDate: string, cadence: Cadence, template: string): string {
  const { year, month } = dateParts(issueDate);
  const date = new Date(`${issueDate}T12:00:00Z`);
  const monthLong = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
  const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  const quarter = `Q${Math.floor((month - 1) / 3) + 1}`;
  const defaultPeriod = cadence === "Annual" ? String(year) : cadence === "Quarterly" ? `${quarter} ${year}` : `${monthLong} ${year}`;
  return clean((template || "{period}")
    .replaceAll("{period}", defaultPeriod)
    .replaceAll("{month}", monthLong)
    .replaceAll("{month_short}", monthShort)
    .replaceAll("{year}", String(year))
    .replaceAll("{quarter}", quarter), 160) || defaultPeriod;
}

async function accountingAccount(business: Business, code: string, requiredType?: "Revenue" | "Asset") {
  const rows = await getSql()`
    SELECT id, code, name, account_type
    FROM accounting_accounts
    WHERE business = ${business} AND code = ${clean(code, 20)} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string; code: string; name: string; account_type: string }>;
  const account = rows[0];
  if (!account) throw new Error(`Accounting account ${code} was not found for ${business}.`);
  if (requiredType && account.account_type !== requiredType) throw new Error(`${code} must be a ${requiredType.toLowerCase()} account.`);
  return account;
}

export function ensureReceivablesSchema(): Promise<void> {
  if (!receivablesSchemaPromise) {
    receivablesSchemaPromise = (async () => {
      await ensureAccountingControlSchema();
      const sql = getSql();
      await sql`
        INSERT INTO accounting_accounts (id, business, code, name, account_type)
        VALUES
          (gen_random_uuid(), 'Corner Deli', '1200', 'Accounts Receivable', 'Asset'),
          (gen_random_uuid(), 'Corner Deli', '4200', 'Rental Income', 'Revenue'),
          (gen_random_uuid(), 'Tiki', '1200', 'Accounts Receivable', 'Asset'),
          (gen_random_uuid(), 'Tiki', '4200', 'Rental Income', 'Revenue')
        ON CONFLICT (business, code) DO NOTHING
      `;
    })().catch((error) => {
      receivablesSchemaPromise = null;
      throw error;
    });
  }
  return receivablesSchemaPromise;
}

async function postInvoice(template: TemplateRow, issueDate: string, actor: string) {
  const key = periodKey(issueDate, template.cadence);
  const label = periodLabel(issueDate, template.cadence, template.label_template);
  const duplicate = await getSql()`
    SELECT id, invoice_number FROM invoices
    WHERE template_id = ${template.id} AND period_key = ${key}
    LIMIT 1
  ` as unknown as Array<{ id: string; invoice_number: string }>;
  if (duplicate[0]) return { created: false, id: duplicate[0].id, invoiceNumber: duplicate[0].invoice_number, duplicate: true };

  const ar = await accountingAccount(template.business, "1200", "Asset");
  const revenue = await accountingAccount(template.business, template.revenue_account_code, "Revenue");
  const amount = roundMoney(numberValue(template.amount));
  const invoiceId = crypto.randomUUID();
  const invoiceNumber = `INV-${issueDate.replaceAll("-", "")}-${invoiceId.slice(0, 6).toUpperCase()}`;
  const dueDate = addDays(issueDate, Number(template.due_days || 0));
  await getSql()`
    INSERT INTO invoices (
      id, business, template_id, invoice_number, customer_name, invoice_date, due_date,
      period_key, period_label, description, amount, balance, revenue_account_code, created_by
    ) VALUES (
      ${invoiceId}, ${template.business}, ${template.id}, ${invoiceNumber}, ${template.customer_name},
      ${issueDate}, ${dueDate}, ${key}, ${label}, ${template.description}, ${amount}, ${amount},
      ${template.revenue_account_code}, ${actor}
    )
  `;

  const entryId = crypto.randomUUID();
  try {
    await getSql()`
      INSERT INTO journal_entries (id, business, entry_date, description, source, reference, created_by)
      VALUES (
        ${entryId}, ${template.business}, ${issueDate},
        ${`${template.customer_name} · ${label}`}, 'Recurring Invoice', ${`invoice:${invoiceId}`}, ${actor}
      )
    `;
    await getSql()`
      INSERT INTO journal_lines (id, entry_id, account_id, debit, credit)
      VALUES
        (${crypto.randomUUID()}, ${entryId}, ${ar.id}, ${amount}, 0),
        (${crypto.randomUUID()}, ${entryId}, ${revenue.id}, 0, ${amount})
    `;
    await getSql()`UPDATE invoices SET journal_entry_id = ${entryId}, updated_at = NOW() WHERE id = ${invoiceId}`;
  } catch (error) {
    await getSql()`DELETE FROM journal_entries WHERE id = ${entryId}`;
    await getSql()`DELETE FROM invoices WHERE id = ${invoiceId}`;
    throw error;
  }
  return { created: true, id: invoiceId, invoiceNumber, periodLabel: label, amount };
}

export async function createRecurringInvoiceTemplate(input: {
  business: Business;
  name: string;
  customerName: string;
  description?: string;
  amount: number;
  revenueAccountCode: string;
  cadence: Cadence;
  dueDays?: number;
  nextIssueDate: string;
  labelTemplate?: string;
  actor: string;
}) {
  await ensureReceivablesSchema();
  const amount = roundMoney(Number(input.amount || 0));
  if (amount <= 0) throw new Error("Recurring invoice amount must be greater than zero.");
  const name = clean(input.name, 160);
  const customerName = clean(input.customerName, 180);
  if (!name || !customerName) throw new Error("Template name and customer are required.");
  if (!(["Monthly", "Quarterly", "Annual"] as Cadence[]).includes(input.cadence)) throw new Error("Choose a valid invoice frequency.");
  await accountingAccount(input.business, input.revenueAccountCode, "Revenue");
  const rows = await getSql()`
    INSERT INTO recurring_invoice_templates (
      id, business, name, customer_name, description, amount, revenue_account_code,
      cadence, due_days, next_issue_date, label_template, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${name}, ${customerName}, ${clean(input.description, 500)},
      ${amount}, ${clean(input.revenueAccountCode, 20)}, ${input.cadence},
      ${Math.max(0, Math.min(365, Math.round(Number(input.dueDays || 0))))},
      ${isoDate(input.nextIssueDate, "First invoice date")}, ${clean(input.labelTemplate, 160) || "{period}"}, ${input.actor}
    )
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  return { id: rows[0].id };
}

export async function setRecurringInvoiceTemplateActive(input: { business: Business; id: string; active: boolean }) {
  await ensureReceivablesSchema();
  const rows = await getSql()`
    UPDATE recurring_invoice_templates
    SET active = ${input.active}, updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business}
    RETURNING id, active
  ` as unknown as Array<{ id: string; active: boolean }>;
  if (!rows[0]) throw new Error("Recurring invoice template was not found.");
  return rows[0];
}

export async function generateTemplateInvoice(input: {
  business: Business;
  templateId: string;
  issueDate?: string;
  actor: string;
}) {
  await ensureReceivablesSchema();
  const rows = await getSql()`
    SELECT id, business, name, customer_name, description, amount, revenue_account_code,
      cadence, due_days, next_issue_date, label_template, active
    FROM recurring_invoice_templates
    WHERE id = ${input.templateId} AND business = ${input.business}
    LIMIT 1
  ` as unknown as TemplateRow[];
  if (!rows[0]) throw new Error("Recurring invoice template was not found.");
  return postInvoice(rows[0], input.issueDate ? isoDate(input.issueDate, "Invoice date") : new Date().toISOString().slice(0, 10), input.actor);
}

export async function generateDueRecurringInvoices(input: {
  business?: Business;
  throughDate?: string;
  actor?: string;
} = {}) {
  await ensureReceivablesSchema();
  const throughDate = input.throughDate ? isoDate(input.throughDate, "Generation date") : new Date().toISOString().slice(0, 10);
  const templates = input.business
    ? await getSql()`
        SELECT id, business, name, customer_name, description, amount, revenue_account_code,
          cadence, due_days, next_issue_date, label_template, active
        FROM recurring_invoice_templates
        WHERE business = ${input.business} AND active = TRUE AND next_issue_date <= ${throughDate}
        ORDER BY next_issue_date
      ` as unknown as TemplateRow[]
    : await getSql()`
        SELECT id, business, name, customer_name, description, amount, revenue_account_code,
          cadence, due_days, next_issue_date, label_template, active
        FROM recurring_invoice_templates
        WHERE active = TRUE AND next_issue_date <= ${throughDate}
        ORDER BY business, next_issue_date
      ` as unknown as TemplateRow[];

  const generated: Array<Record<string, unknown>> = [];
  const failures: Array<{ templateId: string; business: Business; name: string; issueDate: string; error: string }> = [];
  for (const template of templates) {
    let nextDate = String(template.next_issue_date).slice(0, 10);
    let safety = 0;
    try {
      while (nextDate <= throughDate && safety < 24) {
        generated.push({ templateId: template.id, business: template.business, ...(await postInvoice(template, nextDate, input.actor || "Recurring invoice scheduler")) });
        nextDate = advanceIssueDate(nextDate, template.cadence);
        safety += 1;
      }
      await getSql()`
        UPDATE recurring_invoice_templates SET next_issue_date = ${nextDate}, updated_at = NOW()
        WHERE id = ${template.id} AND business = ${template.business}
      `;
    } catch (error) {
      failures.push({
        templateId: template.id,
        business: template.business,
        name: template.name,
        issueDate: nextDate,
        error: error instanceof Error ? error.message : String(error),
      });
      await getSql()`
        UPDATE recurring_invoice_templates SET next_issue_date = ${nextDate}, updated_at = NOW()
        WHERE id = ${template.id} AND business = ${template.business}
      `;
    }
  }
  return { throughDate, templates: templates.length, created: generated.filter((row) => row.created).length, failed: failures.length, failures, generated };
}

async function recalculateInvoice(invoiceId: string) {
  const rows = await getSql()`
    SELECT i.amount, COALESCE(SUM(p.amount), 0) AS paid
    FROM invoices i
    LEFT JOIN invoice_payment_allocations p ON p.invoice_id = i.id
    WHERE i.id = ${invoiceId}
    GROUP BY i.amount
  ` as unknown as Array<{ amount: string | number; paid: string | number }>;
  if (!rows[0]) return;
  const amount = roundMoney(numberValue(rows[0].amount));
  const paid = roundMoney(numberValue(rows[0].paid));
  const balance = Math.max(0, roundMoney(amount - paid));
  const status = balance <= 0.005 ? "Paid" : paid > 0 ? "Partially Paid" : "Open";
  await getSql()`
    UPDATE invoices SET amount_paid = ${paid}, balance = ${balance}, status = ${status}, updated_at = NOW()
    WHERE id = ${invoiceId} AND status <> 'Void'
  `;
}

export async function codeBankTransaction(input: {
  business: Business;
  transactionId: string;
  lines: CodingLine[];
  teach?: boolean;
  actor: string;
}) {
  await ensureReceivablesSchema();
  const transactionRows = await getSql()`
    SELECT t.id, t.external_transaction_id, t.transaction_date, t.merchant_name, t.description,
      t.signed_amount, t.direction, t.pending, t.removed, t.review_status,
      a.account_type
    FROM bank_transactions t
    LEFT JOIN bank_accounts a ON a.external_account_id = t.external_account_id
    LEFT JOIN bank_transaction_postings p ON p.bank_transaction_id = t.id
    WHERE t.id = ${input.transactionId} AND t.business = ${input.business} AND p.id IS NULL
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const transaction = transactionRows[0];
  if (!transaction) throw new Error("Uncoded bank transaction was not found.");
  if (transaction.pending) throw new Error("Pending transactions cannot be coded yet.");
  if (transaction.removed) throw new Error("Removed transactions cannot be coded.");
  if (!input.lines.length) throw new Error("Add at least one coding line.");

  const expected = roundMoney(Math.abs(numberValue(transaction.signed_amount)));
  const normalized = input.lines.map((line) => ({
    accountCode: clean(line.accountCode, 20),
    invoiceId: clean(line.invoiceId, 80),
    amount: roundMoney(Math.abs(Number(line.amount || 0))),
    memo: clean(line.memo, 300),
  }));
  if (normalized.some((line) => line.amount <= 0 || (!line.accountCode && !line.invoiceId) || (line.accountCode && line.invoiceId))) {
    throw new Error("Each coding line needs one account or invoice and a positive amount.");
  }
  const supplied = roundMoney(normalized.reduce((sum, line) => sum + line.amount, 0));
  if (Math.abs(expected - supplied) > 0.005) throw new Error(`Coding lines must total ${expected.toFixed(2)}; supplied ${supplied.toFixed(2)}.`);

  const invoiceAmounts = new Map<string, number>();
  const prepared: Array<{ accountCode: string; invoiceId: string; amount: number; memo: string; category: string }> = [];
  for (const line of normalized) {
    if (line.invoiceId) {
      if (numberValue(transaction.signed_amount) <= 0 || transaction.account_type === "credit") {
        throw new Error("Invoices can only be paid from a bank deposit or other bank inflow.");
      }
      const invoiceRows = await getSql()`
        SELECT id, invoice_number, customer_name, period_label, balance, status
        FROM invoices
        WHERE id = ${line.invoiceId} AND business = ${input.business}
        LIMIT 1
      ` as unknown as Array<{ id: string; invoice_number: string; customer_name: string; period_label: string; balance: string | number; status: string }>;
      const invoice = invoiceRows[0];
      if (!invoice || invoice.status === "Void" || invoice.status === "Paid") throw new Error("The selected invoice is not open.");
      const allocated = roundMoney((invoiceAmounts.get(invoice.id) || 0) + line.amount);
      if (allocated - numberValue(invoice.balance) > 0.005) throw new Error(`${invoice.invoice_number} only has ${numberValue(invoice.balance).toFixed(2)} remaining.`);
      invoiceAmounts.set(invoice.id, allocated);
      prepared.push({
        accountCode: "1200",
        invoiceId: invoice.id,
        amount: line.amount,
        memo: line.memo || `${invoice.invoice_number} · ${invoice.customer_name} · ${invoice.period_label}`,
        category: "Invoice payment",
      });
    } else {
      const account = await accountingAccount(input.business, line.accountCode);
      prepared.push({ accountCode: account.code, invoiceId: "", amount: line.amount, memo: line.memo, category: account.name });
    }
  }

  await getSql()`DELETE FROM bank_transaction_splits WHERE bank_transaction_id = ${input.transactionId}`;
  for (let index = 0; index < prepared.length; index += 1) {
    const line = prepared[index];
    await getSql()`
      INSERT INTO bank_transaction_splits (
        id, bank_transaction_id, line_number, account_code, amount, memo, created_by, invoice_id
      ) VALUES (
        ${crypto.randomUUID()}, ${input.transactionId}, ${index + 1}, ${line.accountCode}, ${line.amount},
        ${line.memo}, ${input.actor}, ${line.invoiceId || null}
      )
    `;
  }

  const category = prepared.length === 1 ? prepared[0].category : `${prepared.length} coded pieces`;
  await getSql()`
    UPDATE bank_transactions SET
      category = ${category},
      account_code = ${prepared.length === 1 ? prepared[0].accountCode : ""},
      classification_source = 'Bank feed coding',
      confidence = 1,
      review_status = 'Approved',
      user_override = TRUE,
      updated_at = NOW()
    WHERE id = ${input.transactionId}
  `;

  if (input.teach && prepared.length === 1 && !prepared[0].invoiceId) {
    const pattern = clean(transaction.merchant_name || transaction.description, 160);
    if (pattern.length >= 3) {
      await getSql()`
        INSERT INTO classification_rules (
          id, business, priority, direction, field, match_type, pattern,
          category, account_code, confidence, created_by
        ) VALUES (
          ${crypto.randomUUID()}, ${input.business}, 50, ${numberValue(transaction.signed_amount) >= 0 ? "Inflow" : "Outflow"},
          ${transaction.merchant_name ? "Merchant" : "Description"}, 'Exact', ${pattern},
          ${prepared[0].category}, ${prepared[0].accountCode}, 1, ${input.actor}
        )
      `;
    }
  }

  const posting = await postFinancialTransaction({ transactionId: input.transactionId, business: input.business, actor: input.actor });
  for (const [invoiceId, amount] of invoiceAmounts) {
    await getSql()`
      INSERT INTO invoice_payment_allocations (
        id, business, invoice_id, bank_transaction_id, amount, created_by
      ) VALUES (
        ${crypto.randomUUID()}, ${input.business}, ${invoiceId}, ${input.transactionId}, ${amount}, ${input.actor}
      )
      ON CONFLICT (invoice_id, bank_transaction_id) DO UPDATE SET
        amount = EXCLUDED.amount,
        created_by = EXCLUDED.created_by
    `;
    await recalculateInvoice(invoiceId);
  }
  return { coded: true, posted: posting.posted, pieces: prepared.length, invoiceAllocations: invoiceAmounts.size, journalEntryId: posting.journalEntryId };
}

export async function receivablesDashboard(business: Business) {
  await ensureReceivablesSchema();
  const [templates, invoices, revenueAccounts] = await Promise.all([
    getSql()`
      SELECT id, name, customer_name, description, amount, revenue_account_code,
        cadence, due_days, next_issue_date, label_template, active, created_at
      FROM recurring_invoice_templates
      WHERE business = ${business}
      ORDER BY active DESC, next_issue_date, customer_name
    `,
    getSql()`
      SELECT i.id, i.invoice_number, i.customer_name, i.invoice_date, i.due_date,
        i.period_label, i.description, i.amount, i.amount_paid, i.balance, i.status,
        i.revenue_account_code, t.name AS template_name
      FROM invoices i
      JOIN recurring_invoice_templates t ON t.id = i.template_id
      WHERE i.business = ${business}
      ORDER BY CASE i.status WHEN 'Open' THEN 0 WHEN 'Partially Paid' THEN 1 WHEN 'Paid' THEN 2 ELSE 3 END,
        i.due_date, i.invoice_date DESC
      LIMIT 300
    `,
    getSql()`
      SELECT code, name FROM accounting_accounts
      WHERE business = ${business} AND account_type = 'Revenue' AND active = TRUE
      ORDER BY code
    `,
  ]);

  const invoiceRows = invoices as unknown as Array<Record<string, unknown>>;
  return {
    templates: (templates as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      customerName: String(row.customer_name),
      description: String(row.description || ""),
      amount: numberValue(row.amount),
      revenueAccountCode: String(row.revenue_account_code),
      cadence: String(row.cadence),
      dueDays: Number(row.due_days || 0),
      nextIssueDate: String(row.next_issue_date).slice(0, 10),
      labelTemplate: String(row.label_template),
      active: Boolean(row.active),
    })),
    invoices: invoiceRows.map((row) => ({
      id: String(row.id),
      invoiceNumber: String(row.invoice_number),
      customerName: String(row.customer_name),
      invoiceDate: String(row.invoice_date).slice(0, 10),
      dueDate: String(row.due_date).slice(0, 10),
      periodLabel: String(row.period_label),
      description: String(row.description || ""),
      amount: numberValue(row.amount),
      amountPaid: numberValue(row.amount_paid),
      balance: numberValue(row.balance),
      status: String(row.status),
      revenueAccountCode: String(row.revenue_account_code),
      templateName: String(row.template_name),
    })),
    openInvoices: invoiceRows.filter((row) => row.status === "Open" || row.status === "Partially Paid").map((row) => ({
      id: String(row.id),
      invoiceNumber: String(row.invoice_number),
      customerName: String(row.customer_name),
      periodLabel: String(row.period_label),
      dueDate: String(row.due_date).slice(0, 10),
      balance: numberValue(row.balance),
    })),
    revenueAccounts: (revenueAccounts as unknown as Array<Record<string, unknown>>).map((row) => ({ code: String(row.code), name: String(row.name) })),
  };
}
