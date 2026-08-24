"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./accounting-control.css";

type Account = { code: string; name: string; accountType: string };
type Tx = {
  id: string;
  externalAccountId: string;
  transactionDate: string;
  merchantName: string;
  description: string;
  signedAmount: number;
  pending: boolean;
  category: string;
  accountCode: string;
  reviewStatus: string;
  posted: boolean;
  reconciled: boolean;
  splits: Array<{ accountCode: string; amount: number; memo: string }>;
};
type RecurringTemplate = {
  id: string;
  name: string;
  customerName: string;
  description: string;
  amount: number;
  revenueAccountCode: string;
  cadence: string;
  dueDays: number;
  nextIssueDate: string;
  labelTemplate: string;
  active: boolean;
};
type Invoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  periodLabel: string;
  description: string;
  amount: number;
  amountPaid: number;
  balance: number;
  status: string;
  revenueAccountCode: string;
  templateName: string;
};
type OpenInvoice = Pick<Invoice, "id" | "invoiceNumber" | "customerName" | "periodLabel" | "dueDate" | "balance">;
type Receivables = {
  templates: RecurringTemplate[];
  invoices: Invoice[];
  openInvoices: OpenInvoice[];
  revenueAccounts: Array<{ code: string; name: string }>;
};
type Dashboard = {
  accounts: Account[];
  bankAccounts: Array<{ externalAccountId: string; institutionName: string; name: string; mask: string; currentBalance: number | null }>;
  transactions: Tx[];
  reconciliations: Array<Record<string, unknown>>;
  unbalancedEntries: Array<{ id: string; entryDate: string; description: string; source: string; debits: number; credits: number; difference: number }>;
  monthly: Array<{ month: string; revenue: number; expenses: number; profit: number }>;
  squareDepositMatches: Array<Record<string, unknown>>;
  squareDays: Array<Record<string, unknown>>;
  receivables: Receivables;
};
type SquareDash = { summary: { orders: number; sales: number; taxes: number; tips: number } };
type CodingLine = { target: string; amount: string; memo: string };

const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
const localDate = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
};
async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function AccountingControlPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<Dashboard | null>(null);
  const [square, setSquare] = useState<SquareDash | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [codingTx, setCodingTx] = useState<Tx | null>(null);
  const [codingLines, setCodingLines] = useState<CodingLine[]>([{ target: "", amount: "", memo: "" }]);
  const [teachRule, setTeachRule] = useState(true);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.json()).then(setSession);
  }, []);

  async function load(active = business) {
    setNotice("");
    const [accountingResponse, squareResponse] = await Promise.all([
      fetch(`/api/accounting-control?business=${encodeURIComponent(active)}`, { cache: "no-store" }),
      fetch("/api/accounting-control?area=square", { cache: "no-store" }),
    ]);
    if (!accountingResponse.ok) throw new Error(await errorMessage(accountingResponse));
    setData(await accountingResponse.json() as Dashboard);
    if (squareResponse.ok) setSquare(await squareResponse.json() as SquareDash);
  }

  useEffect(() => {
    if (session?.authenticated) void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/accounting-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = await response.json();
      await load();
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const transactions = useMemo(() => [...(data?.transactions || [])].sort((left, right) => {
    if (left.posted !== right.posted) return left.posted ? 1 : -1;
    return right.transactionDate.localeCompare(left.transactionDate);
  }), [data?.transactions]);
  const uncoded = transactions.filter((transaction) => !transaction.posted && !transaction.pending);
  const outstanding = (data?.receivables.openInvoices || []).reduce((sum, invoice) => sum + invoice.balance, 0);
  const codingTotal = codingLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const codingDifference = codingTx ? Math.round((Math.abs(codingTx.signedAmount) - codingTotal) * 100) / 100 : 0;
  const maxProfit = Math.max(1, ...(data?.monthly || []).map((month) => Math.max(0, month.profit)));

  function beginCoding(transaction: Tx) {
    setCodingTx(transaction);
    setTeachRule(true);
    setCodingLines(transaction.splits.length
      ? transaction.splits.map((line) => ({ target: `account:${line.accountCode}`, amount: String(line.amount), memo: line.memo }))
      : [{ target: transaction.accountCode ? `account:${transaction.accountCode}` : "", amount: String(Math.abs(transaction.signedAmount)), memo: "" }]);
  }

  async function saveCoding() {
    if (!codingTx) return;
    const lines = codingLines.map((line) => {
      const separator = line.target.indexOf(":");
      const kind = separator >= 0 ? line.target.slice(0, separator) : "";
      const value = separator >= 0 ? line.target.slice(separator + 1) : "";
      return {
        accountCode: kind === "account" ? value : undefined,
        invoiceId: kind === "invoice" ? value : undefined,
        amount: Number(line.amount || 0),
        memo: line.memo,
      };
    });
    const result = await post({ action: "transaction-code", business, transactionId: codingTx.id, lines, teach: teachRule });
    setCodingTx(null);
    setNotice(`Transaction coded in ${result.pieces} piece${result.pieces === 1 ? "" : "s"}${result.invoiceAllocations ? ` and applied to ${result.invoiceAllocations} invoice${result.invoiceAllocations === 1 ? "" : "s"}` : ""}.`);
  }

  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await post({
      action: "recurring-template-create",
      business,
      name: form.get("name"),
      customerName: form.get("customerName"),
      description: form.get("description"),
      amount: Number(form.get("amount") || 0),
      revenueAccountCode: form.get("revenueAccountCode"),
      cadence: form.get("cadence"),
      dueDays: Number(form.get("dueDays") || 0),
      nextIssueDate: form.get("nextIssueDate"),
      labelTemplate: form.get("labelTemplate"),
    });
    formElement.reset();
    setNotice("Recurring invoice template created.");
  }

  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const finalize = submitter?.value === "finalize";
    const result = await post({
      action: "reconciliation-save",
      business,
      externalAccountId: form.get("externalAccountId"),
      statementStartDate: form.get("statementStartDate"),
      statementEndDate: form.get("statementEndDate"),
      beginningBalance: Number(form.get("beginningBalance") || 0),
      endingBalance: Number(form.get("endingBalance") || 0),
      transactionIds: selected,
      notes: form.get("notes"),
      finalize,
    });
    setNotice(`Reconciliation ${result.status}. Difference: ${dollars(result.difference)}.`);
  }

  async function openingBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await post({
      action: "opening-balance",
      business,
      entryDate: form.get("entryDate"),
      description: form.get("description"),
      reference: form.get("reference"),
      lines: [
        { accountCode: form.get("assetCode"), debit: Number(form.get("assetDebit") || 0), credit: Number(form.get("assetCredit") || 0) },
        { accountCode: form.get("offsetCode"), debit: Number(form.get("offsetDebit") || 0), credit: Number(form.get("offsetCredit") || 0) },
      ],
    });
    formElement.reset();
    setNotice("Opening balance posted.");
  }

  async function historyImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      form.set("action", "historical-import");
      form.set("business", business);
      form.set("postApproved", String(form.get("postApproved") === "on"));
      const response = await fetch("/api/accounting-control", { method: "POST", body: form });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = await response.json();
      await load();
      setNotice(`Imported ${result.imported} coded transactions; posted ${result.posted}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage"><p>Loading…</p></main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage accountingPage">
    <header className="controlHeader">
      <div><p className="eyebrow">Bank feed and receivables</p><h1>{business} transactions</h1><p>Code each imported bank or card transaction. Splits and invoice payments create the accounting entry automatically, because manually posting routine bank activity is an excellent use of nobody’s afternoon.</p></div>
      <div className="controlActions"><div className="businessPills">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => { setBusiness(name); setSelected([]); setCodingTx(null); }}>{name}</button>)}</div><button disabled={busy} onClick={() => void load()}>Refresh</button><a href="/ops/settings">Settings</a></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <section className="controlCard"><div className="metricGrid"><div className="metric"><span>Needs coding</span><strong>{uncoded.length}</strong></div><div className="metric"><span>Coded transactions</span><strong>{transactions.filter((transaction) => transaction.posted).length}</strong></div><div className="metric"><span>Open invoices</span><strong>{data?.receivables.openInvoices.length || 0}</strong></div><div className="metric"><span>Outstanding invoices</span><strong>{dollars(outstanding)}</strong></div></div></section>

    <section className="controlCard transactionCard">
      <div className="sectionHeading"><div><p className="eyebrow">Primary workflow</p><h2>Bank and credit-card transactions</h2></div><span>Code once. The journal entry happens behind the scenes.</span></div>
      <div className="tableWrap"><table className="controlTable"><thead><tr><th></th><th>Date / payee</th><th>Amount</th><th>Coding</th><th>Status</th><th></th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.id} className={!transaction.posted ? "needsCoding" : ""}><td className="checkCell"><input type="checkbox" checked={selected.includes(transaction.id)} disabled={transaction.reconciled} onChange={(event) => setSelected((value) => event.target.checked ? [...value, transaction.id] : value.filter((id) => id !== transaction.id))} /></td><td><strong>{transaction.merchantName || transaction.description}</strong><small>{transaction.transactionDate} · {transaction.description}</small></td><td className={`amount ${transaction.signedAmount >= 0 ? "in" : "out"}`}>{dollars(transaction.signedAmount)}</td><td>{transaction.splits.length ? `${transaction.splits.length} pieces` : transaction.accountCode || "Not coded"}<small>{transaction.category}</small></td><td><span className={`badge ${transaction.reconciled || transaction.posted ? "good" : transaction.pending ? "warn" : "bad"}`}>{transaction.reconciled ? "Reconciled" : transaction.posted ? "Coded" : transaction.pending ? "Pending" : "Needs coding"}</span></td><td><button className="primary" onClick={() => beginCoding(transaction)} disabled={busy || transaction.posted || transaction.pending}>{transaction.posted ? "Coded" : "Code"}</button></td></tr>)}</tbody></table></div>
    </section>

    {codingTx && <section className="controlCard codingPanel">
      <div className="sectionHeading"><div><p className="eyebrow">Code transaction</p><h2>{codingTx.merchantName || codingTx.description}</h2><span>{codingTx.transactionDate} · {dollars(Math.abs(codingTx.signedAmount))}</span></div><button onClick={() => setCodingTx(null)}>Close</button></div>
      <div className="codingLines">{codingLines.map((line, index) => <div className="codingLine" key={index}><label>Code to<select value={line.target} onChange={(event) => setCodingLines((value) => value.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item))}><option value="">Choose an account or invoice</option>{codingTx.signedAmount > 0 && data?.receivables.openInvoices.length ? <optgroup label="Open invoices">{data.receivables.openInvoices.map((invoice) => <option key={invoice.id} value={`invoice:${invoice.id}`}>{invoice.invoiceNumber} · {invoice.customerName} · {invoice.periodLabel} · {dollars(invoice.balance)}</option>)}</optgroup> : null}<optgroup label="Accounting categories">{data?.accounts.filter((account) => !["1000", "1200"].includes(account.code)).map((account) => <option key={account.code} value={`account:${account.code}`}>{account.code} · {account.name}</option>)}</optgroup></select></label><label>Amount<input value={line.amount} type="number" min="0.01" step="0.01" onChange={(event) => setCodingLines((value) => value.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} /></label><label>Memo / invoice detail<input value={line.memo} placeholder="Optional" onChange={(event) => setCodingLines((value) => value.map((item, itemIndex) => itemIndex === index ? { ...item, memo: event.target.value } : item))} /></label><button onClick={() => setCodingLines((value) => value.filter((_, itemIndex) => itemIndex !== index))} disabled={codingLines.length === 1}>Remove</button></div>)}</div>
      <div className={`codingBalance ${Math.abs(codingDifference) <= 0.005 ? "balanced" : "unbalanced"}`}><span>Coded {dollars(codingTotal)}</span><strong>{Math.abs(codingDifference) <= 0.005 ? "Balanced" : `${dollars(Math.abs(codingDifference))} ${codingDifference > 0 ? "remaining" : "over"}`}</strong></div>
      <div className="controlActions"><button onClick={() => setCodingLines((value) => [...value, { target: "", amount: "", memo: "" }])}>Add another piece</button><label className="teachRule"><input type="checkbox" checked={teachRule} onChange={(event) => setTeachRule(event.target.checked)} disabled={codingLines.length !== 1 || codingLines[0].target.startsWith("invoice:")} /> Use this coding automatically next time</label><button className="primary" disabled={busy || Math.abs(codingDifference) > 0.005 || codingLines.some((line) => !line.target)} onClick={() => void saveCoding()}>Save and code transaction</button></div>
    </section>}

    <div className="accountingTwoColumn">
      <section className="controlCard">
        <div className="sectionHeading"><div><p className="eyebrow">Recurring billing</p><h2>Invoice templates</h2></div><button disabled={busy} onClick={() => void post({ action: "recurring-generate-due", business, throughDate: localDate() }).then((result) => setNotice(`Generated ${result.created} due invoice${result.created === 1 ? "" : "s"}.`))}>Generate due invoices</button></div>
        <form className="controlForm recurringForm" onSubmit={createTemplate}>
          <label>Template name<input name="name" placeholder="Dock rental" required /></label>
          <label>Customer / tenant<input name="customerName" required /></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
          <label>Frequency<select name="cadence" defaultValue="Monthly"><option>Monthly</option><option>Quarterly</option><option>Annual</option></select></label>
          <label>First invoice date<input name="nextIssueDate" type="date" defaultValue={localDate()} required /></label>
          <label>Due after<input name="dueDays" type="number" min="0" max="365" defaultValue="0" /><small>Days after invoice date</small></label>
          <label>Income account<select name="revenueAccountCode" defaultValue="4200">{data?.receivables.revenueAccounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label>
          <label>Period label<input name="labelTemplate" defaultValue="{month} {year} Rent" /><small>Use {`{month}`}, {`{year}`}, {`{quarter}`}, or {`{period}`}.</small></label>
          <label className="wide">Description<input name="description" placeholder="Monthly rental income" /></label>
          <button className="primary" disabled={busy}>Create recurring invoice</button>
        </form>
        <div className="invoiceTemplateList">{data?.receivables.templates.map((template) => <article key={template.id}><div><strong>{template.name}</strong><span>{template.customerName} · {dollars(template.amount)} {template.cadence.toLowerCase()}</span><small>Next: {template.nextIssueDate} · Label: {template.labelTemplate}</small></div><div><span className={`badge ${template.active ? "good" : "warn"}`}>{template.active ? "Active" : "Paused"}</span><button disabled={busy} onClick={() => void post({ action: "recurring-generate-one", business, templateId: template.id, issueDate: localDate() }).then((result) => setNotice(result.created ? `Created ${result.invoiceNumber}.` : `${result.invoiceNumber} already exists for this period.`))}>Generate now</button><button disabled={busy} onClick={() => void post({ action: "recurring-template-active", business, id: template.id, active: !template.active })}>{template.active ? "Pause" : "Resume"}</button></div></article>)}{!data?.receivables.templates.length && <p>No recurring invoice templates yet.</p>}</div>
      </section>

      <section className="controlCard">
        <div className="sectionHeading"><div><p className="eyebrow">Receivables</p><h2>Invoices</h2></div><strong>{dollars(outstanding)} outstanding</strong></div>
        <div className="invoiceList">{data?.receivables.invoices.map((invoice) => <article key={invoice.id}><div><strong>{invoice.customerName} · {invoice.periodLabel}</strong><span>{invoice.invoiceNumber} · Due {invoice.dueDate}</span><small>{invoice.description || invoice.templateName}</small></div><div><strong>{dollars(invoice.balance)}</strong><span className={`badge ${invoice.status === "Paid" ? "good" : invoice.status === "Partially Paid" ? "warn" : "bad"}`}>{invoice.status}</span><small>{dollars(invoice.amountPaid)} paid of {dollars(invoice.amount)}</small></div></article>)}{!data?.receivables.invoices.length && <p>No invoices have been generated.</p>}</div>
      </section>
    </div>

    <section className="controlCard">
      <details className="advancedAccounting"><summary>Reconciliation and advanced accounting</summary><div className="advancedGrid">
        <section><p className="eyebrow">Statement control</p><h2>Bank reconciliation</h2><form className="controlForm" onSubmit={reconcile}><label>Bank account<select name="externalAccountId" required><option value="">Choose account</option>{data?.bankAccounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>{account.institutionName} · {account.name} •{account.mask}</option>)}</select></label><label>Selected transactions<input value={`${selected.length} selected`} readOnly /></label><label>Statement start<input name="statementStartDate" type="date" required /></label><label>Statement end<input name="statementEndDate" type="date" required /></label><label>Beginning balance<input name="beginningBalance" type="number" step="0.01" required /></label><label>Ending balance<input name="endingBalance" type="number" step="0.01" required /></label><label className="wide">Notes<textarea name="notes" /></label><div className="controlActions wide"><button type="submit">Save draft</button><button type="submit" value="finalize" className="primary" disabled={busy}>Finalize</button></div></form></section>
        <section><p className="eyebrow">Rare manual setup</p><h2>Opening balance</h2><form className="controlForm" onSubmit={openingBalance}><label>Date<input name="entryDate" type="date" defaultValue={localDate()} required /></label><label>Description<input name="description" defaultValue="Opening balances" required /></label><label>Debit account<select name="assetCode">{data?.accounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label><label>Debit amount<input name="assetDebit" type="number" step="0.01" /></label><label>Credit account<select name="offsetCode">{data?.accounts.map((account) => <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}</select></label><label>Credit amount<input name="offsetCredit" type="number" step="0.01" /></label><label className="wide">Reference<input name="reference" /></label><button className="primary" disabled={busy}>Post opening entry</button></form></section>
        <section><p className="eyebrow">History migration</p><h2>Import coded workbook</h2><form className="controlForm" onSubmit={historyImport}><label>Institution/source<input name="institutionName" defaultValue="Historical bookkeeping" /></label><label>Control account<select name="accountType" defaultValue="depository"><option value="depository">Bank / cash account</option><option value="credit">Credit-card account</option></select></label><label>Workbook<input name="file" type="file" accept=".xlsx,.xls,.csv" required /></label><label className="wide"><span><input name="postApproved" type="checkbox" /> Post imported approved rows immediately</span></label><button className="primary" disabled={busy}>Import history</button></form></section>
        <section><p className="eyebrow">Ledger repair</p><h2>Unbalanced entries</h2>{data?.unbalancedEntries.length ? <div className="controlList">{data.unbalancedEntries.map((entry) => <div key={entry.id}><strong>{entry.entryDate} · {entry.description}</strong><small>{entry.source} · difference {dollars(entry.difference)}</small><button disabled={busy} onClick={() => void post({ action: "journal-reverse", business, entryId: entry.id, reason: "Reversed from accounting control after balance review" }).then(() => setNotice("Journal entry reversed."))}>Reverse entry</button></div>)}</div> : <p>No unbalanced entries detected.</p>}</section>
        <section><p className="eyebrow">18-month trend</p><h2>Monthly profit</h2><div className="chartBars">{data?.monthly.map((month) => <div className="chartBar" key={month.month} title={`${month.month}: ${dollars(month.profit)}`}><i style={{ height: `${Math.max(2, (Math.max(0, month.profit) / maxProfit) * 180)}px` }} /><small>{month.month}</small></div>)}</div></section>
      </div></details>
    </section>

    {business === "Tiki" && <section className="controlCard"><div className="sectionHeading"><div><p className="eyebrow">Square controls</p><h2>Tiki sales integration</h2></div><div className="controlActions"><button className="primary" onClick={() => void post({ action: "square-sync-full" }).then((result) => setNotice(`Square synced: ${result.orders} orders.`))} disabled={busy}>Full Square sync</button><button onClick={() => void post({ action: "square-match-build" }).then((result) => setNotice(`Built ${result.created} deposit suggestions.`))}>Build deposit matches</button></div></div><div className="metricGrid"><div className="metric"><span>Orders, 30 days</span><strong>{square?.summary.orders || 0}</strong></div><div className="metric"><span>Sales</span><strong>{dollars(square?.summary.sales || 0)}</strong></div><div className="metric"><span>Tax</span><strong>{dollars(square?.summary.taxes || 0)}</strong></div><div className="metric"><span>Tips</span><strong>{dollars(square?.summary.tips || 0)}</strong></div></div></section>}
  </main>;
}
