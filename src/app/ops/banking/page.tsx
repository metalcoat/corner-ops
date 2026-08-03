"use client";

import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./banking.css";

type Suggestion = {
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

type Payload = {
  business: Business;
  summary: {
    totalUnposted: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    noSuggestion: number;
    savedRules: number;
    learnedExamples: number;
  };
  suggestions: Suggestion[];
};

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function BankingPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [minimumConfidence, setMinimumConfidence] = useState(0.9);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: SessionView) => {
        setSession(value);
        const allowed = value.businesses || [];
        if (allowed.length && !allowed.includes(business)) setBusiness(allowed[0]);
      })
      .catch(() => setNotice("Unable to load the current account."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/banking?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await errorMessage(response));
    const payload = await response.json() as Payload;
    setData(payload);
    setSelected(payload.suggestions.filter((item) => !item.pending && item.accountCode && item.confidence >= minimumConfidence).map((item) => item.id));
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  const eligible = useMemo(() => (data?.suggestions || []).filter((item) => !item.pending && item.accountCode && item.confidence >= minimumConfidence), [data, minimumConfidence]);

  useEffect(() => {
    setSelected((current) => current.filter((id) => eligible.some((item) => item.id === id)));
  }, [eligible]);

  async function apply(transactionIds: string[]) {
    if (!transactionIds.length) {
      setNotice("No transactions meet the selected confidence level.");
      return;
    }
    if (!window.confirm(`Code and post ${transactionIds.length} transaction${transactionIds.length === 1 ? "" : "s"} using the displayed suggestions?`)) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/banking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply-suggestions", business, minimumConfidence, transactionIds }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = await response.json() as { coded: number; failed: number };
      await load(business);
      setNotice(`Coded and posted ${result.coded} transaction${result.coded === 1 ? "" : "s"}${result.failed ? `; ${result.failed} need manual review` : ""}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Suggested coding could not be applied.");
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage">Loading banking…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in to Corner Ops</a></main>;
  const allowed = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main className="controlPage bankingPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Bank feed intelligence</p>
        <h1>{business} banking</h1>
        <p>Corner Ops learns from the transactions you code, scores the remaining matches, and waits for an actual human to approve the batch before touching the books. Revolutionary restraint.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => { setBusiness(name); setSelected([]); }}>{name}</button>)}</div>
        <button disabled={busy} onClick={() => void load()}>Refresh</button>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <section className="bankingQuickLinks">
      <a className="primary" href="/ops/accounting-control"><strong>Code transactions</strong><span>Splits, invoices, recurring billing, and reconciliation</span></a>
      <a href="/ops/expense-control"><strong>Cards & receipts</strong><span>Receipt OCR and card-payment matching</span></a>
      <a href="/ops/bank-accounts"><strong>Connected accounts</strong><span>Manage bank and credit-card feeds</span></a>
    </section>

    <section className="controlCard"><div className="metricGrid">
      <div className="metric"><span>High confidence</span><strong>{data?.summary.highConfidence || 0}</strong></div>
      <div className="metric"><span>Needs judgment</span><strong>{(data?.summary.mediumConfidence || 0) + (data?.summary.lowConfidence || 0)}</strong></div>
      <div className="metric"><span>No suggestion</span><strong>{data?.summary.noSuggestion || 0}</strong></div>
      <div className="metric"><span>Learned examples</span><strong>{data?.summary.learnedExamples || 0}</strong></div>
    </div></section>

    <section className="controlCard bankingApproval">
      <div className="bankingApprovalHeader">
        <div><p className="eyebrow">Bulk approval</p><h2>Suggested coding</h2><p>Only single-account suggestions are eligible. Split deposits and invoice allocations still require manual coding.</p></div>
        <div className="bankingApprovalActions">
          <label>Minimum confidence<select value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))}><option value="0.8">80%</option><option value="0.85">85%</option><option value="0.9">90%</option><option value="0.95">95%</option></select></label>
          <button onClick={() => setSelected(eligible.map((item) => item.id))}>Select eligible</button>
          <button className="primary" disabled={busy || selected.length === 0} onClick={() => void apply(selected)}>Approve selected ({selected.length})</button>
        </div>
      </div>

      <div className="bankSuggestionList">
        {(data?.suggestions || []).map((item) => {
          const selectable = !item.pending && Boolean(item.accountCode) && item.confidence >= minimumConfidence;
          return <article className={`bankSuggestion ${item.confidenceBand.toLowerCase()}`} key={item.id}>
            <input type="checkbox" aria-label={`Select ${item.merchantName || item.description}`} disabled={!selectable || busy} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
            <div className="bankSuggestionTransaction"><strong>{item.merchantName || item.description || "Bank transaction"}</strong><span>{item.transactionDate} · {item.description}</span><b className={item.signedAmount >= 0 ? "in" : "out"}>{money(item.signedAmount)}</b></div>
            <div className="bankSuggestionCode"><span>{item.accountCode ? `${item.accountCode} · ${item.accountName}` : "No coding suggestion"}</span><small>{item.category || item.source}</small></div>
            <div className="bankConfidence"><strong>{item.confidencePercent}%</strong><div><i style={{ width: `${item.confidencePercent}%` }} /></div><small>{item.confidenceBand} · {item.source}</small></div>
          </article>;
        })}
        {!data?.suggestions.length && <p>No unposted transactions are waiting for coding.</p>}
      </div>
    </section>
  </main>;
}
