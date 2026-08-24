"use client";

import { formatUsd } from "@/app/client-format";
import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./card-statements.css";

type MatchCandidate = {
  id: string;
  date: string;
  merchantName: string;
  description: string;
  amount: number;
  dateDistance: number;
};

type Statement = {
  id: string;
  business: Business;
  issuer: string;
  accountName: string;
  lastFour: string;
  statementEndDate: string;
  statementBalance: number;
  paymentAmount: number;
  fileName: string;
  extractionStatus: string;
  parsedTransactionCount: number;
  parsedTotal: number;
  matchStatus: "Unmatched" | "Suggested" | "Matched";
  suggestedBankTransactionId: string | null;
  matchedBankTransactionId: string | null;
  bankTransaction: MatchCandidate | null;
  candidates: MatchCandidate[];
  createdAt: string;
};

type Dashboard = { statements: Statement[] };

function requestedBusiness(): Business {
  if (typeof window === "undefined") return "Corner Deli";
  return new URLSearchParams(window.location.search).get("business") === "Tiki" ? "Tiki" : "Corner Deli";
}



export default function CardStatementsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(requestedBusiness);
  const [dashboard, setDashboard] = useState<Dashboard>({ statements: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedMatches, setSelectedMatches] = useState<Record<string, string>>({});

  async function load(activeBusiness = business) {
    const response = await fetch(`/api/card-statements?business=${encodeURIComponent(activeBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setDashboard(await response.json() as Dashboard);
  }

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function uploadStatement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    form.set("business", business);
    try {
      const response = await fetch("/api/card-statements", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as {
        extractionStatus: string;
        parsedTransactionCount: number;
        candidateCount: number;
      };
      event.currentTarget.reset();
      await load();
      setNotice(`${result.extractionStatus}. Parsed ${result.parsedTransactionCount} card transactions and found ${result.candidateCount} possible bank-payment match${result.candidateCount === 1 ? "" : "es"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Card statement upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmMatch(statement: Statement) {
    const bankTransactionId = selectedMatches[statement.id]
      || statement.matchedBankTransactionId
      || statement.suggestedBankTransactionId
      || statement.candidates[0]?.id;
    if (!bankTransactionId) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/card-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm-match",
          business,
          statementId: statement.id,
          bankTransactionId,
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(`${statement.issuer} statement matched to its bank payment.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Statement match failed.");
    } finally {
      setBusy(false);
    }
  }

  const matched = useMemo(() => dashboard.statements.filter((statement) => statement.matchStatus === "Matched").length, [dashboard.statements]);
  const needsMatch = dashboard.statements.length - matched;

  if (!session) return <main className="controlPage statementPage">Loading card statements…</main>;
  if (!session.authenticated) return <main className="controlPage statementPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage statementPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Bank and card reconciliation</p>
        <h1>{business} credit-card statements</h1>
        <p>Upload the card statement, extract spreadsheet transactions when available, and match the statement payment to the corresponding bank withdrawal.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills" aria-label="Business">
          {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button type="button" key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
        </div>
        <a className="controlLink" href={`/ops/integrations?business=${encodeURIComponent(business)}`}>Back to integrations</a>
      </div>
    </header>

    {notice && <div className="statementNotice">{notice}</div>}

    <section className="statementStats">
      <article><span>Statements</span><strong>{dashboard.statements.length}</strong></article>
      <article><span>Matched payments</span><strong>{matched}</strong></article>
      <article><span>Need matching</span><strong>{needsMatch}</strong></article>
    </section>

    <section className="statementLayout">
      <article className="controlCard statementUploadCard">
        <div><p className="eyebrow">New statement</p><h2>Upload PDF or spreadsheet</h2><p>PDFs are securely retained and matched using the payment amount. CSV and Excel files also extract transaction lines for review.</p></div>
        <form className="statementForm" onSubmit={uploadStatement}>
          <label>Card issuer or card name<input name="issuer" placeholder="Chase Ink, Capital One, Amex" required /></label>
          <label>Account label<input name="accountName" placeholder={business === "Tiki" ? "At The Docks operating card" : "Corner Deli operating card"} /></label>
          <label>Last four digits<input name="lastFour" inputMode="numeric" pattern="[0-9]{0,4}" maxLength={4} /></label>
          <label>Statement ending date<input name="statementEndDate" type="date" required /></label>
          <label>Statement balance<input name="statementBalance" type="number" step="0.01" min="0" required /></label>
          <label>Payment amount to match<input name="paymentAmount" type="number" step="0.01" min="0" required /></label>
          <label className="statementFile">Statement file<input name="file" type="file" accept=".pdf,.csv,.xlsx,.xls" required /></label>
          <button type="submit" className="statementPrimary" disabled={busy}>Upload and find payment</button>
        </form>
      </article>

      <section className="statementList" aria-label="Uploaded card statements">
        {dashboard.statements.map((statement) => {
          const options = statement.candidates.length
            ? statement.candidates
            : statement.bankTransaction ? [statement.bankTransaction] : [];
          const selected = selectedMatches[statement.id]
            || statement.matchedBankTransactionId
            || statement.suggestedBankTransactionId
            || options[0]?.id
            || "";
          return <article className={`controlCard statementCard status-${statement.matchStatus.toLowerCase()}`} key={statement.id}>
            <header>
              <div><p className="eyebrow">Ending {new Date(`${statement.statementEndDate}T12:00:00`).toLocaleDateString()}</p><h2>{statement.issuer}{statement.lastFour ? ` •••• ${statement.lastFour}` : ""}</h2><span>{statement.accountName || business}</span></div>
              <strong className="statementStatus">{statement.matchStatus}</strong>
            </header>
            <div className="statementAmounts">
              <div><span>Statement balance</span><strong>{formatUsd(statement.statementBalance)}</strong></div>
              <div><span>Payment to match</span><strong>{formatUsd(statement.paymentAmount)}</strong></div>
              <div><span>Extracted lines</span><strong>{statement.parsedTransactionCount}</strong></div>
            </div>
            <div className="statementFileRow"><span>{statement.fileName} · {statement.extractionStatus}</span><a href={`/api/card-statements/${statement.id}/download`}>Download</a></div>

            {statement.matchStatus === "Matched" && statement.bankTransaction ? <div className="matchedPayment"><strong>Matched bank withdrawal</strong><span>{statement.bankTransaction.date} · {statement.bankTransaction.merchantName || statement.bankTransaction.description} · {formatUsd(statement.bankTransaction.amount)}</span></div> : options.length ? <div className="matchChooser">
              <label>Possible bank payment<select value={selected} onChange={(event) => setSelectedMatches((current) => ({ ...current, [statement.id]: event.target.value }))}>{options.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.date} · {formatUsd(candidate.amount)} · {candidate.merchantName || candidate.description}</option>)}</select></label>
              <button type="button" disabled={busy || !selected} onClick={() => void confirmMatch(statement)}>Confirm payment match</button>
            </div> : <div className="unmatchedPayment"><strong>No exact bank withdrawal found.</strong><span>Import or sync the bank account, then reopen this page. The payment amount must match exactly.</span></div>}
          </article>;
        })}
        {!dashboard.statements.length && <div className="controlCard statementEmpty">No card statements uploaded for {business}.</div>}
      </section>
    </section>
  </main>;
}
