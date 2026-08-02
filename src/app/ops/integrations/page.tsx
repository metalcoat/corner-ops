"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "./integrations.css";

type Connection = {
  id: string;
  provider: "Plaid" | "Square" | "CSV";
  business: Business;
  institutionName: string;
  status: string;
  lastSyncAt: string | null;
};
type BankAccount = {
  id: string;
  institutionName: string;
  name: string;
  officialName: string;
  mask: string;
  currentBalance: number | null;
  availableBalance: number | null;
};
type BankTransaction = {
  id: string;
  transactionDate: string;
  merchantName: string;
  description: string;
  signedAmount: number;
  category: string;
  accountCode: string;
  classificationSource: string;
  confidence: number;
  reviewStatus: string;
};
type AccountingAccount = { code: string; name: string; accountType: string };
type Issue = { id: string; business: Business; severity: string; title: string; details: string; lastSeenAt: string };
type SyncRun = { id: string; provider: string; business: Business; status: string; recordsAdded: number; message: string; startedAt: string };
type SchedulerRun = { id: string; status: string; localDate: string; details: Record<string, unknown>; startedAt: string };
type Dashboard = {
  configuration: {
    plaid: boolean;
    plaidEnvironment: string;
    square: boolean;
    squareEnvironment: string;
    cron: boolean;
    alerts: boolean;
  };
  connections: Connection[];
  accounts: BankAccount[];
  transactions: BankTransaction[];
  accountingAccounts: AccountingAccount[];
  issues: Issue[];
  syncRuns: SyncRun[];
  schedulerRuns: SchedulerRun[];
  payrollRuns: Array<{ id: string; weekStart: string; status: string; generatedAt: string }>;
  squareSummary: { sales: number; tips: number; payments: number };
};

type PlaidMetadata = { institution?: { name?: string } };
type PlaidHandler = {
  open: () => void;
  destroy: () => void;
};
type PlaidStatic = {
  create: (options: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: PlaidMetadata) => void;
    onExit: (error: unknown) => void;
  }) => PlaidHandler;
};

declare global {
  interface Window {
    Plaid?: PlaidStatic;
  }
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="cdn.plaid.com/link"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Plaid Link could not load.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Plaid Link could not load."));
    document.head.appendChild(script);
  });
}

export default function IntegrationsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [accountSelections, setAccountSelections] = useState<Record<string, string>>({});

  async function api(body: Record<string, unknown>) {
    const response = await fetch("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await responseMessage(response));
    return response.json();
  }

  async function load() {
    const response = await fetch(`/api/integrations?business=${encodeURIComponent(business)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setDashboard(await response.json() as Dashboard);
  }

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  useEffect(() => {
    if (session?.authenticated) void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthState = params.get("oauth_state_id");
    const stored = sessionStorage.getItem("corner-ops-plaid-link");
    if (!oauthState || !stored || !session?.authenticated) return;
    const saved = JSON.parse(stored) as { token: string; business: Business };
    setBusiness(saved.business);
    void launchPlaid(saved.business, saved.token, window.location.href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated]);

  async function launchPlaid(targetBusiness: Business, existingToken?: string, receivedRedirectUri?: string) {
    setBusy(true);
    setNotice("");
    try {
      const tokenResult = existingToken
        ? { linkToken: existingToken }
        : await api({ action: "plaid-link-token", business: targetBusiness }) as { linkToken: string };
      sessionStorage.setItem("corner-ops-plaid-link", JSON.stringify({ token: tokenResult.linkToken, business: targetBusiness }));
      await loadPlaidScript();
      if (!window.Plaid) throw new Error("Plaid Link was unavailable after loading.");
      const handler = window.Plaid.create({
        token: tokenResult.linkToken,
        receivedRedirectUri,
        onSuccess: (publicToken, metadata) => {
          void (async () => {
            try {
              await api({
                action: "plaid-exchange",
                business: targetBusiness,
                publicToken,
                institutionName: metadata.institution?.name || "Connected bank",
              });
              sessionStorage.removeItem("corner-ops-plaid-link");
              window.history.replaceState({}, "", "/ops/integrations");
              await load();
              setNotice(`${targetBusiness} bank connection created and synchronized.`);
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "Bank connection failed.");
            } finally {
              setBusy(false);
              handler.destroy();
            }
          })();
        },
        onExit: (error) => {
          if (error) setNotice("Plaid Link closed before the bank was connected.");
          setBusy(false);
          handler.destroy();
        },
      });
      handler.open();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Plaid connection failed.");
      setBusy(false);
    }
  }

  async function runAction(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await api(body);
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function importBankFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    form.set("action", "bank-file-import");
    form.set("business", business);
    try {
      const response = await fetch("/api/integrations", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { imported: number; rowsRead: number };
      event.currentTarget.reset();
      await load();
      setNotice(`Imported ${result.imported} of ${result.rowsRead} bank rows.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Bank file import failed.");
    } finally {
      setBusy(false);
    }
  }

  const businessConnections = dashboard?.connections.filter((connection) => connection.business === business) || [];
  const bankConnections = businessConnections.filter((connection) => connection.provider === "Plaid");
  const squareConnection = dashboard?.connections.find((connection) => connection.provider === "Square");
  const reviewTransactions = dashboard?.transactions.filter((transaction) => transaction.reviewStatus === "Needs Review") || [];
  const totalBalance = useMemo(
    () => (dashboard?.accounts || []).reduce((total, account) => total + Number(account.currentBalance || 0), 0),
    [dashboard?.accounts],
  );

  if (!session) return <main className="centered"><div className="loginCard"><h1>Loading integrations</h1></div></main>;
  if (!session.authenticated) return <main className="centered"><section className="loginCard"><h1>Owner access required</h1><a className="primary" href="/">Return to sign-in</a></section></main>;

  return <main className="integrationShell">
    <header className="integrationHeader">
      <div><p className="eyebrow">Connections and scheduler</p><h1>Automation center</h1><p className="muted">Square, bank feeds, categorization, scheduled checks, and sync history.</p></div>
      <div className="businessSwitch">{(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div>
    </header>

    {notice && <div className="notice integrationNotice">{notice}</div>}

    <section className="stats fourStats integrationStats">
      <article><span>Connected banks</span><strong>{bankConnections.length}</strong></article>
      <article><span>Bank balance</span><strong>{money(totalBalance)}</strong></article>
      <article><span>Needs review</span><strong>{reviewTransactions.length}</strong></article>
      <article><span>Open issues</span><strong>{dashboard?.issues.filter((issue) => issue.business === business).length || 0}</strong></article>
    </section>

    <section className="integrationGrid">
      <article className="panel integrationCard">
        <div className="panelHeader"><div><p className="eyebrow">Bank feed</p><h3>{business === "Corner Deli" ? "SEACOMM" : "NBT Bank"}</h3></div><span className={`badge ${dashboard?.configuration.plaid ? "active" : "needsreview"}`}>{dashboard?.configuration.plaid ? dashboard.configuration.plaidEnvironment : "Needs Plaid keys"}</span></div>
        <div className="integrationBody">
          <p>Connect the bank through Plaid, then transactions synchronize into the review queue and accounting categories.</p>
          <button className="primary" disabled={busy || !dashboard?.configuration.plaid} onClick={() => void launchPlaid(business)}>Connect {business === "Corner Deli" ? "SEACOMM" : "NBT"}</button>
          {bankConnections.map((connection) => <div className="connectionRow" key={connection.id}><div><strong>{connection.institutionName}</strong><small>Last sync: {connection.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleString() : "Never"}</small></div><button className="secondary" disabled={busy} onClick={() => void runAction({ action: "bank-sync", connectionId: connection.id }, `${connection.institutionName} synchronized.`)}>Sync now</button></div>)}
        </div>
      </article>

      <article className="panel integrationCard">
        <div className="panelHeader"><div><p className="eyebrow">Tiki sales source</p><h3>Square</h3></div><span className={`badge ${squareConnection ? "active" : "needsreview"}`}>{squareConnection ? "Connected" : dashboard?.configuration.square ? "Ready to connect" : "Needs Square keys"}</span></div>
        <div className="integrationBody">
          {business === "Tiki" ? <>
            <p>Square supplies Tiki payment and tip activity. Corner Ops time remains the employee time-clock source.</p>
            <div className="miniStats"><div><span>30-day payments</span><strong>{dashboard?.squareSummary.payments || 0}</strong></div><div><span>Sales</span><strong>{money(dashboard?.squareSummary.sales || 0)}</strong></div><div><span>Tips</span><strong>{money(dashboard?.squareSummary.tips || 0)}</strong></div></div>
            {!squareConnection && <a className={`primary ${!dashboard?.configuration.square ? "disabledLink" : ""}`} href={dashboard?.configuration.square ? "/api/square/connect" : undefined}>Connect Square</a>}
            {squareConnection && <button className="secondary" disabled={busy} onClick={() => void runAction({ action: "square-sync", connectionId: squareConnection.id }, "Square synchronized.")}>Sync Square now</button>}
          </> : <p>Square belongs to Tiki. Switch to Tiki to connect or review it.</p>}
        </div>
      </article>

      <article className="panel integrationCard">
        <div className="panelHeader"><div><p className="eyebrow">Nightly automation</p><h3>Scheduler</h3></div><span className={`badge ${dashboard?.configuration.cron ? "active" : "needsreview"}`}>{dashboard?.configuration.cron ? "Configured" : "Needs CRON_SECRET"}</span></div>
        <div className="integrationBody">
          <p>Runs at 3 AM New York time, checks Tiki open punches, verifies Rezku freshness, syncs both banks and Square, and saves Monday payroll runs.</p>
          <button className="secondary" disabled={busy} onClick={() => void runAction({ action: "scheduler-run" }, "Scheduler completed manually.")}>Run scheduler now</button>
          <div className="compactList">{(dashboard?.schedulerRuns || []).slice(0, 5).map((run) => <div key={run.id}><strong>{run.status} · {run.localDate}</strong><span>{new Date(run.startedAt).toLocaleString()}</span></div>)}</div>
        </div>
      </article>

      <article className="panel integrationCard">
        <div className="panelHeader"><div><p className="eyebrow">Fallback</p><h3>Bank file import</h3></div></div>
        <form className="stackForm integrationBody" onSubmit={importBankFile}>
          <label>Institution<input name="institutionName" defaultValue={business === "Corner Deli" ? "SEACOMM" : "NBT Bank"} required /></label>
          <label>CSV or Excel<input name="file" type="file" accept=".csv,.xlsx,.xls" required /></label>
          <button className="secondary" disabled={busy}>Import transactions</button>
        </form>
      </article>
    </section>

    <section className="panel integrationSection">
      <div className="panelHeader"><div><p className="eyebrow">Accounting review</p><h3>{business} bank transactions</h3></div><span className="badge needsreview">{reviewTransactions.length} need review</span></div>
      <div className="dataTableWrap"><table className="dataTable"><thead><tr><th>Date</th><th>Merchant / description</th><th>Amount</th><th>Suggested category</th><th>Account</th><th></th></tr></thead><tbody>
        {(dashboard?.transactions || []).map((transaction) => {
          const selected = accountSelections[transaction.id] || transaction.accountCode;
          const account = dashboard?.accountingAccounts.find((candidate) => candidate.code === selected);
          return <tr key={transaction.id}><td>{transaction.transactionDate}</td><td><strong>{transaction.merchantName || transaction.description}</strong><small>{transaction.description}</small><small>{transaction.classificationSource} · {Math.round(transaction.confidence * 100)}%</small></td><td className={transaction.signedAmount < 0 ? "negativeAmount" : "positiveAmount"}>{money(transaction.signedAmount)}</td><td>{transaction.category || "Uncategorized"}</td><td><select value={selected} onChange={(event: { target: { value: string } }) => setAccountSelections((current) => ({ ...current, [transaction.id]: event.target.value }))}>{(dashboard?.accountingAccounts || []).map((candidate) => <option key={candidate.code} value={candidate.code}>{candidate.code} · {candidate.name}</option>)}</select></td><td>{transaction.reviewStatus === "Approved" ? <span className="badge active">Approved</span> : <button className="textButton neutral approveButton" disabled={busy || !account} onClick={() => void runAction({ action: "transaction-approve", id: transaction.id, business, category: account?.name || transaction.category, accountCode: selected, teach: true }, "Transaction approved and future matching transactions will learn from it.")}>Approve & teach</button>}</td></tr>;
        })}
        {!dashboard?.transactions.length && <tr><td colSpan={6}>No bank transactions have been imported yet.</td></tr>}
      </tbody></table></div>
    </section>

    <section className="integrationGrid lowerGrid">
      <article className="panel integrationCard"><div className="panelHeader"><div><p className="eyebrow">Issues</p><h3>Needs attention</h3></div></div><div className="compactList">{(dashboard?.issues || []).filter((issue) => issue.business === business).map((issue) => <div key={issue.id}><strong>{issue.severity}: {issue.title}</strong><span>{issue.details}</span></div>)}{!dashboard?.issues.filter((issue) => issue.business === business).length && <div className="empty">No open issues.</div>}</div></article>
      <article className="panel integrationCard"><div className="panelHeader"><div><p className="eyebrow">Sync history</p><h3>Recent activity</h3></div></div><div className="compactList">{(dashboard?.syncRuns || []).filter((run) => run.business === business).slice(0, 12).map((run) => <div key={run.id}><strong>{run.provider} · {run.status} · {run.recordsAdded} new</strong><span>{run.message || new Date(run.startedAt).toLocaleString()}</span></div>)}{!dashboard?.syncRuns.filter((run) => run.business === business).length && <div className="empty">No sync runs yet.</div>}</div></article>
    </section>
  </main>;
}
