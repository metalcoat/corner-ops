"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./expense-control.css";

type Account = {
  id: string;
  institutionName: string;
  name: string;
  officialName: string;
  mask: string;
  accountType: string;
  accountSubtype: string;
  currentBalance: number | null;
  availableBalance: number | null;
  currency: string;
  active: boolean;
  lastSyncAt: string | null;
  connectionStatus: string;
};

type Transfer = {
  id: string;
  amount: number;
  dateDifference: number;
  confidence: number;
  status: string;
  bankDate: string;
  bankMerchant: string;
  bankAccount: string;
  cardDate: string;
  cardMerchant: string;
  cardAccount: string;
};

type Receipt = {
  id: string;
  source: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string;
  ocrStatus: string;
  merchantName: string;
  receiptDate: string | null;
  totalAmount: number | null;
  taxAmount: number | null;
  currency: string;
  ocrError: string;
  createdAt: string;
};

type ReceiptMatch = {
  id: string;
  receiptId: string;
  transactionId: string;
  confidence: number;
  amountVariance: number;
  dateDifference: number;
  merchantScore: number;
  status: string;
  fileName: string;
  receiptMerchant: string;
  receiptDate: string | null;
  totalAmount: number;
  transactionDate: string;
  transactionMerchant: string;
  transactionAmount: number;
  accountName: string;
  accountType: string;
};

type Dashboard = {
  business: Business;
  configuration: {
    plaid: boolean;
    googleServiceAccount: boolean;
    documentAi: boolean;
    driveFolderConfigured: boolean;
    driveFolderId: string;
  };
  counts: {
    bankAccounts: number;
    creditCards: number;
    suggestedTransfers: number;
    processedReceipts: number;
    receiptFailures: number;
    suggestedReceiptMatches: number;
    matchedReceipts: number;
  };
  accounts: Account[];
  transfers: Transfer[];
  receipts: Receipt[];
  receiptMatches: ReceiptMatch[];
};

const money = (value: number | null) => value === null
  ? "Not available"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const local = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function ExpenseControlPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => {
        setSession(payload);
        const allowed = payload.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/expense-control?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Dashboard);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    setNotice("");
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function action(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/expense-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cards and receipts action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("business", business);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/expense-control", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { status?: string; error?: string };
      await load();
      formElement.reset();
      setNotice(result.status === "Processed"
        ? "Receipt uploaded, read, and sent through transaction matching."
        : `Receipt uploaded. OCR status: ${result.status || "stored"}${result.error ? ` · ${result.error}` : ""}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Receipt upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage">Loading cards and receipts…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);
  const suggestedTransfers = (data?.transfers || []).filter((item) => item.status === "Suggested");
  const suggestedReceipts = (data?.receiptMatches || []).filter((item) => item.status === "Suggested");

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Expense evidence and transfers</p>
        <h1>{business} cards & receipts</h1>
        <p>Credit-card purchases, card-payment matching, receipt OCR, and the paper trail humans somehow still manufacture.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div>
        <button disabled={busy} onClick={() => void action({ action: "refresh" }, "Bank, card, transfer, and receipt matching refreshed.")}>Refresh everything</button>
        <button disabled={busy} onClick={() => void action({ action: "drive-sync" }, "Google Drive receipt folders scanned.")}>Scan Drive</button>
        <a href="/ops/integrations">Connect accounts</a>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <div className="controlGrid">
      <section className="controlCard">
        <div className="expenseSummary">
          <article><span>Bank accounts</span><strong>{data?.counts.bankAccounts || 0}</strong></article>
          <article><span>Credit cards</span><strong>{data?.counts.creditCards || 0}</strong></article>
          <article><span>Payment matches to review</span><strong>{data?.counts.suggestedTransfers || 0}</strong></article>
          <article><span>Receipts read</span><strong>{data?.counts.processedReceipts || 0}</strong></article>
          <article><span>Receipt matches to review</span><strong>{data?.counts.suggestedReceiptMatches || 0}</strong></article>
          <article><span>OCR failures</span><strong>{data?.counts.receiptFailures || 0}</strong></article>
        </div>
      </section>

      <section className="controlCard">
        <div className="expenseSectionHeader"><div><p className="eyebrow">Configuration</p><h2>Connection readiness</h2></div></div>
        <div className="expenseStatusGrid">
          <div className={`expenseStatus ${data?.configuration.plaid ? "good" : "warn"}`}><strong>Plaid</strong><span>{data?.configuration.plaid ? "Ready for banks and cards" : "Credentials missing"}</span></div>
          <div className={`expenseStatus ${data?.configuration.googleServiceAccount ? "good" : "warn"}`}><strong>Google service account</strong><span>{data?.configuration.googleServiceAccount ? "Drive access available" : "Credentials missing"}</span></div>
          <div className={`expenseStatus ${data?.configuration.documentAi ? "good" : "warn"}`}><strong>Document AI</strong><span>{data?.configuration.documentAi ? "Expense OCR ready" : "Processor not configured"}</span></div>
          <div className={`expenseStatus ${data?.configuration.driveFolderConfigured ? "good" : "warn"}`}><strong>{business} receipt folder</strong><span>{data?.configuration.driveFolderConfigured ? "Drive folder configured" : "Folder ID missing"}</span></div>
        </div>
      </section>

      <section className="controlCard">
        <div className="expenseSectionHeader"><div><p className="eyebrow">Any supported image or PDF</p><h2>Upload a receipt</h2></div></div>
        <form className="expenseUpload" onSubmit={upload}>
          <label>Receipt file<input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,image/tiff,image/bmp" required /></label>
          <button disabled={busy}>Upload & read</button>
        </form>
      </section>

      <section className="controlCard">
        <div className="expenseSectionHeader"><div><p className="eyebrow">Plaid accounts</p><h2>Connected banks and cards</h2></div><a href="/ops/integrations">Add another issuer</a></div>
        <div className="expenseAccounts">{(data?.accounts || []).map((account) => <article className={`expenseAccount ${account.accountType === "credit" ? "credit" : "bank"}`} key={account.id}><div><strong>{account.institutionName} · {account.name}</strong><span>{account.accountType === "credit" ? "Credit card" : account.accountSubtype || account.accountType} {account.mask ? `ending ${account.mask}` : ""}</span><small>Last sync: {local(account.lastSyncAt)} · {account.connectionStatus}</small></div><div className="expenseBalance"><strong>{money(account.currentBalance)}</strong><small>{account.accountType === "credit" ? "Current amount owed" : "Current balance"}</small></div></article>)}{!data?.accounts.length && <p className="expenseEmpty">No Plaid accounts connected for this business.</p>}</div>
      </section>

      <section className="controlCard">
        <div className="expenseSectionHeader"><div><p className="eyebrow">Checking payment ↔ card credit</p><h2>Credit-card payment matches</h2></div><span className="expenseBadge suggested">{suggestedTransfers.length} need review</span></div>
        <div className="expenseMatches">{(data?.transfers || []).map((item) => <article className="expenseMatch" key={item.id}><header><div><strong>{money(item.amount)}</strong><span>{item.status} · {percent(item.confidence)} confidence · {item.dateDifference} day difference</span></div><span className={`expenseBadge ${item.status.toLowerCase()}`}>{item.status}</span></header><div className="expensePair"><div><strong>{item.bankAccount}</strong><span>{item.bankMerchant}</span><small>{item.bankDate}</small></div><div className="expenseArrow">→</div><div><strong>{item.cardAccount}</strong><span>{item.cardMerchant}</span><small>{item.cardDate}</small></div></div>{item.status === "Suggested" && <div className="expenseActions"><button disabled={busy} onClick={() => void action({ action: "transfer-review", id: item.id, accept: true }, "Credit-card payment matched and mirror transaction ignored.")}>Confirm match</button><button className="secondary" disabled={busy} onClick={() => void action({ action: "transfer-review", id: item.id, accept: false }, "Payment suggestion ignored.")}>Not a match</button></div>}</article>)}{!data?.transfers.length && <p className="expenseEmpty">No card-payment matches yet. Connect the card issuer and its paying bank account, then refresh.</p>}</div>
      </section>

      <section className="controlCard">
        <div className="expenseSectionHeader"><div><p className="eyebrow">Document AI extraction</p><h2>Receipt inbox</h2></div><span className="expenseBadge matched">{data?.counts.matchedReceipts || 0} matched</span></div>
        <div className="expenseReceipts">{(data?.receipts || []).map((receipt) => <article className="expenseReceipt" key={receipt.id}><header><div><strong>{receipt.merchantName || receipt.fileName}</strong><span>{receipt.fileName} · {receipt.source}</span></div><span className={`expenseBadge ${receipt.ocrStatus.toLowerCase().replaceAll(" ", "-")}`}>{receipt.ocrStatus}</span></header><div className="expenseReceiptMeta"><span>Date: {receipt.receiptDate || "Not read"}</span><span>Total: {money(receipt.totalAmount)}</span><span>Tax: {money(receipt.taxAmount)}</span><span>Uploaded: {local(receipt.createdAt)}</span>{receipt.sourceUrl && <a href={receipt.sourceUrl} target="_blank" rel="noreferrer">Open Drive file</a>}</div>{receipt.ocrError && <div className="expenseReceiptError">{receipt.ocrError}</div>}</article>)}{!data?.receipts.length && <p className="expenseEmpty">No receipts have been uploaded or found in Drive.</p>}</div>
      </section>

      <section className="controlCard">
        <div className="expenseSectionHeader"><div><p className="eyebrow">Amount + date + merchant</p><h2>Receipt transaction matches</h2></div><span className="expenseBadge suggested">{suggestedReceipts.length} need review</span></div>
        <div className="expenseMatches">{(data?.receiptMatches || []).map((item) => <article className="expenseMatch" key={item.id}><header><div><strong>{item.receiptMerchant || item.fileName}</strong><span>{item.status} · {percent(item.confidence)} confidence · variance {money(item.amountVariance)}</span></div><span className={`expenseBadge ${item.status.toLowerCase()}`}>{item.status}</span></header><div className="expensePair"><div><strong>Receipt · {money(item.totalAmount)}</strong><span>{item.fileName}</span><small>{item.receiptDate || "Date not read"}</small></div><div className="expenseArrow">→</div><div><strong>{item.accountName} · {money(item.transactionAmount)}</strong><span>{item.transactionMerchant}</span><small>{item.transactionDate} · {item.accountType === "credit" ? "Credit card" : "Bank"}</small></div></div>{item.status === "Suggested" && <div className="expenseActions"><button disabled={busy} onClick={() => void action({ action: "receipt-review", id: item.id, accept: true }, "Receipt attached to transaction.")}>Confirm receipt</button><button className="secondary" disabled={busy} onClick={() => void action({ action: "receipt-review", id: item.id, accept: false }, "Receipt suggestion ignored.")}>Not a match</button></div>}</article>)}{!data?.receiptMatches.length && <p className="expenseEmpty">No receipt matches yet.</p>}</div>
      </section>

      <section className="controlCard"><p className="expenseNote"><strong>Accounting behavior:</strong> a confirmed checking-account payment is classified to the Credit Cards liability account. The matching credit on the card feed is ignored as the mirror side, so the payment is not counted twice. Card purchases remain their own expense transactions and can receive the OCR receipt attachment.</p></section>
    </div>
  </main>;
}
