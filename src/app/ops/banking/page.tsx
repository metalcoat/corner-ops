"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
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

type TrendPoint = {
  key: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  transfers: number;
  transactions: number;
};

type CategoryPoint = {
  category: string;
  amount: number;
  count: number;
  priorAmount: number;
  changePercent: number | null;
};

type MerchantPoint = {
  merchant: string;
  amount: number;
  count: number;
  category: string;
};

type AccountPoint = {
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
  updatedAt: string;
};

type BankingInsight = {
  id: string;
  tone: "positive" | "warning" | "critical" | "info";
  title: string;
  detail: string;
  metric?: string;
};

type Anomaly = {
  id: string;
  date: string;
  merchant: string;
  description: string;
  category: string;
  amount: number;
  accountName: string;
  reason: string;
};

type FinancialPayload = {
  business: Business;
  range: {
    start: string;
    end: string;
    priorStart: string;
    priorEnd: string;
    dayCount: number;
    interval: "day" | "week" | "month";
  };
  summary: {
    inflows: number;
    outflows: number;
    netCashFlow: number;
    transfers: number;
    transactionCount: number;
    operatingTransactionCount: number;
    pendingCount: number;
    postedCount: number;
    reviewedCount: number;
    uncategorizedCount: number;
    uncategorizedAmount: number;
    currentCash: number;
    availableCash: number;
    cardBalance: number;
    averageMonthlyInflow: number;
    averageMonthlyOutflow: number;
    cashRunwayMonths: number | null;
    inflowChangePercent: number | null;
    outflowChangePercent: number | null;
    netChangePercent: number | null;
    postingPercent: number;
    codingPercent: number;
  };
  priorSummary: {
    inflows: number;
    outflows: number;
    netCashFlow: number;
    transfers: number;
    transactionCount: number;
  };
  trend: TrendPoint[];
  categories: CategoryPoint[];
  merchants: MerchantPoint[];
  accounts: AccountPoint[];
  reconciliation: {
    matchedStatements: number;
    unmatchedStatements: number;
    staleConnections: number;
    activeConnections: number;
    connections: Array<{
      id: string;
      provider: string;
      institutionName: string;
      status: string;
      lastSyncAt: string | null;
      stale: boolean;
    }>;
  };
  anomalies: Anomaly[];
  insights: BankingInsight[];
  generatedAt: string;
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
  financial: FinancialPayload;
};

type PeriodPreset = "this-month" | "three-months" | "six-months" | "ytd" | "twelve-months" | "prior-year" | "all" | "custom";
type ChartInterval = "day" | "week" | "month";

const money = (value: number, digits = 0) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: digits,
}).format(value || 0);

function localDateText(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function dateFromText(value: string) {
  return new Date(`${value}T12:00:00`);
}

function dateText(value: Date) {
  return localDateText(value);
}

function firstOfMonth(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), 1, 12);
}

function presetRange(preset: PeriodPreset) {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  if (preset === "this-month") return { start: firstOfMonth(end), end };
  if (preset === "three-months") return { start: new Date(end.getFullYear(), end.getMonth() - 2, 1, 12), end };
  if (preset === "six-months") return { start: new Date(end.getFullYear(), end.getMonth() - 5, 1, 12), end };
  if (preset === "twelve-months") return { start: new Date(end.getFullYear(), end.getMonth() - 11, 1, 12), end };
  if (preset === "prior-year") return {
    start: new Date(end.getFullYear() - 1, 0, 1, 12),
    end: new Date(end.getFullYear() - 1, 11, 31, 12),
  };
  if (preset === "all") return { start: new Date(2024, 0, 1, 12), end };
  return { start: new Date(end.getFullYear(), 0, 1, 12), end };
}

function changeLabel(value: number | null, inverse = false) {
  if (value === null) return "No prior base";
  if (value === 0) return "No change";
  const favorable = inverse ? value < 0 : value > 0;
  return `${value > 0 ? "+" : ""}${value}% vs prior` + (favorable ? "" : "");
}

function changeClass(value: number | null, inverse = false) {
  if (value === null || value === 0) return "neutral";
  const favorable = inverse ? value < 0 : value > 0;
  return favorable ? "good" : "bad";
}

async function errorMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function MetricCard({ label, value, detail, change, changeTone = "neutral", tone = "" }: {
  label: string;
  value: string;
  detail?: string;
  change?: string;
  changeTone?: "good" | "bad" | "neutral";
  tone?: string;
}) {
  return <article className={`bankKpi ${tone}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <div>{detail && <small>{detail}</small>}{change && <b className={changeTone}>{change}</b>}</div>
  </article>;
}

function CashFlowChart({ data }: { data: TrendPoint[] }) {
  if (!data.length) return <div className="bankChartEmpty">No transactions fall inside this period.</div>;
  const width = 1000;
  const height = 340;
  const left = 62;
  const right = 24;
  const top = 24;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const positiveMax = Math.max(1, ...data.flatMap((item) => [item.inflow, item.net, 0]));
  const negativeMin = Math.min(-1, ...data.flatMap((item) => [-item.outflow, item.net, 0]));
  const span = positiveMax - negativeMin;
  const y = (value: number) => top + ((positiveMax - value) / span) * plotHeight;
  const zeroY = y(0);
  const groupWidth = plotWidth / data.length;
  const barWidth = Math.max(3, Math.min(24, groupWidth * .28));
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));
  const path = data.map((item, index) => {
    const x = left + groupWidth * index + groupWidth / 2;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y(item.net).toFixed(1)}`;
  }).join(" ");
  const gridValues = Array.from({ length: 5 }, (_, index) => negativeMin + (span * index) / 4);

  return <div className="bankCashChartWrap">
    <div className="bankChartLegend"><span className="inflow">Cash in</span><span className="outflow">Cash out</span><span className="net">Net cash</span></div>
    <svg className="bankCashChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cash inflows, outflows, and net cash flow over time">
      {gridValues.map((value) => <g key={value}>
        <line className="chartGrid" x1={left} x2={width - right} y1={y(value)} y2={y(value)} />
        <text className="chartAxisLabel" x={left - 9} y={y(value) + 4} textAnchor="end">{money(value)}</text>
      </g>)}
      <line className="chartZero" x1={left} x2={width - right} y1={zeroY} y2={zeroY} />
      {data.map((item, index) => {
        const center = left + groupWidth * index + groupWidth / 2;
        const inflowY = y(item.inflow);
        const outflowY = y(-item.outflow);
        return <g key={item.key}>
          <title>{`${item.label}: ${money(item.inflow, 2)} in, ${money(item.outflow, 2)} out, ${money(item.net, 2)} net`}</title>
          <rect className="chartInflow" x={center - barWidth - 1} y={inflowY} width={barWidth} height={Math.max(1, zeroY - inflowY)} rx="3" />
          <rect className="chartOutflow" x={center + 1} y={zeroY} width={barWidth} height={Math.max(1, outflowY - zeroY)} rx="3" />
          {index % labelEvery === 0 && <text className="chartXAxis" x={center} y={height - 18} textAnchor="middle">{item.label}</text>}
        </g>;
      })}
      <path className="chartNetLine" d={path} fill="none" />
      {data.map((item, index) => {
        const x = left + groupWidth * index + groupWidth / 2;
        return <circle className="chartNetPoint" key={item.key} cx={x} cy={y(item.net)} r={data.length > 30 ? 2.5 : 4}><title>{`${item.label}: ${money(item.net, 2)} net`}</title></circle>;
      })}
    </svg>
  </div>;
}

function CategoryBars({ data, total }: { data: CategoryPoint[]; total: number }) {
  const shown = data.slice(0, 10);
  const max = Math.max(1, ...shown.map((item) => item.amount));
  if (!shown.length) return <div className="bankChartEmpty">No operating outflows are available for this period.</div>;
  return <div className="categoryBars">
    {shown.map((item) => <div className="categoryBarRow" key={item.category}>
      <div><strong>{item.category}</strong><span>{item.count} transaction{item.count === 1 ? "" : "s"} · {total ? Math.round(item.amount / total * 100) : 0}%</span></div>
      <div className="categoryBarTrack"><i style={{ width: `${Math.max(2, item.amount / max * 100)}%` }} /></div>
      <div className="categoryBarAmount"><strong>{money(item.amount)}</strong><span className={changeClass(item.changePercent, true)}>{changeLabel(item.changePercent, true)}</span></div>
    </div>)}
  </div>;
}

function requestedBusiness(): Business | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("business");
  return value === "Tiki" || value === "Corner Deli" ? value : null;
}

export default function BankingPage() {
  const initialRange = presetRange("ytd");
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(requestedBusiness() || "Corner Deli");
  const [data, setData] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [minimumConfidence, setMinimumConfidence] = useState(0.9);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("ytd");
  const [startDate, setStartDate] = useState(dateText(initialRange.start));
  const [endDate, setEndDate] = useState(dateText(initialRange.end));
  const [interval, setInterval] = useState<ChartInterval>("month");
  const [showCoding, setShowCoding] = useState(false);

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

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    const url = new URL(window.location.href);
    url.searchParams.set("business", business);
    window.history.replaceState(null, "", url);
  }, [business]);

  async function load(activeBusiness = business, rangeStart = startDate, rangeEnd = endDate, activeInterval = interval) {
    setBusy(true);
    try {
      const params = new URLSearchParams({
        business: activeBusiness,
        start: rangeStart,
        end: rangeEnd,
        interval: activeInterval,
      });
      const response = await fetch(`/api/banking?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response));
      const payload = await response.json() as Payload;
      setData(payload);
      setSelected(payload.suggestions.filter((item) => !item.pending && item.accountCode && item.confidence >= minimumConfidence).map((item) => item.id));
    } finally {
      setBusy(false);
    }
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

  function choosePreset(preset: PeriodPreset) {
    setPeriodPreset(preset);
    if (preset === "custom") return;
    const range = presetRange(preset);
    const nextStart = dateText(range.start);
    const nextEnd = dateText(range.end);
    setStartDate(nextStart);
    setEndDate(nextEnd);
    void load(business, nextStart, nextEnd, interval).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }

  function applyRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPeriodPreset("custom");
    setNotice("");
    void load(business, startDate, endDate, interval).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }

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
  const financial = data?.financial;
  const summary = financial?.summary;
  const rangeLabel = financial
    ? `${dateFromText(financial.range.start).toLocaleDateString()} – ${dateFromText(financial.range.end).toLocaleDateString()}`
    : `${dateFromText(startDate).toLocaleDateString()} – ${dateFromText(endDate).toLocaleDateString()}`;

  return <main className="controlPage bankingPage">
    <header className="controlHeader bankingHero">
      <div>
        <p className="eyebrow">Financial command center</p>
        <h1>{business} banking</h1>
        <p>Cash movement, balances, spending, reconciliation, exceptions, and transaction coding in one place. The figures reflect connected and imported bank data, because accounting dashboards should disclose where their numbers came from instead of practicing confidence theater.</p>
      </div>
      <div className="controlActions">
        <div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => { setBusiness(name); setSelected([]); }}>{name}</button>)}</div>
        <button disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh data"}</button>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <section className="bankPeriodPanel controlCard">
      <div className="bankPeriodTop">
        <div><p className="eyebrow">Reporting period</p><h2>{rangeLabel}</h2><span>Compared with the immediately preceding {financial?.range.dayCount || 0}-day period.</span></div>
        <div className="periodPresetButtons">
          {([
            ["this-month", "This month"],
            ["three-months", "3 months"],
            ["six-months", "6 months"],
            ["ytd", "Year to date"],
            ["twelve-months", "12 months"],
            ["prior-year", "Prior year"],
            ["all", "All data"],
          ] as Array<[PeriodPreset, string]>).map(([value, label]) => <button type="button" key={value} className={periodPreset === value ? "active" : ""} disabled={busy} onClick={() => choosePreset(value)}>{label}</button>)}
        </div>
      </div>
      <form className="bankDateForm" onSubmit={applyRange}>
        <label>Start date<input type="date" value={startDate} max={endDate} onChange={(event) => { setStartDate(event.target.value); setPeriodPreset("custom"); }} required /></label>
        <label>End date<input type="date" value={endDate} min={startDate} onChange={(event) => { setEndDate(event.target.value); setPeriodPreset("custom"); }} required /></label>
        <label>Chart interval<select value={interval} onChange={(event) => {
          const next = event.target.value as ChartInterval;
          setInterval(next);
          void load(business, startDate, endDate, next).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
        }}><option value="month">Monthly</option><option value="week">Weekly</option><option value="day">Daily</option></select></label>
        <button className="primary" disabled={busy}>Apply custom range</button>
      </form>
    </section>

    <section className="bankKpiGrid">
      <MetricCard label="Connected cash" value={money(summary?.currentCash || 0)} detail={`${money(summary?.availableCash || 0)} available`} tone="cash" />
      <MetricCard label="Cash received" value={money(summary?.inflows || 0)} detail={`${summary?.transactionCount || 0} total bank transactions`} change={changeLabel(summary?.inflowChangePercent ?? null)} changeTone={changeClass(summary?.inflowChangePercent ?? null)} tone="inflow" />
      <MetricCard label="Operating outflow" value={money(summary?.outflows || 0)} detail={`${money(summary?.averageMonthlyOutflow || 0)} monthly average`} change={changeLabel(summary?.outflowChangePercent ?? null, true)} changeTone={changeClass(summary?.outflowChangePercent ?? null, true)} tone="outflow" />
      <MetricCard label="Net operating cash" value={money(summary?.netCashFlow || 0)} detail={`${money(summary?.transfers || 0)} transfers/settlements excluded`} change={changeLabel(summary?.netChangePercent ?? null)} changeTone={changeClass(summary?.netChangePercent ?? null)} tone={(summary?.netCashFlow || 0) >= 0 ? "positive" : "negative"} />
      <MetricCard label="Credit-card balances" value={money(summary?.cardBalance || 0)} detail={`${financial?.reconciliation.unmatchedStatements || 0} statements need matching`} tone="cards" />
      <MetricCard label="Cash coverage" value={summary?.cashRunwayMonths === null || summary?.cashRunwayMonths === undefined ? "Not available" : `${summary.cashRunwayMonths.toFixed(1)} mo.`} detail="Connected cash ÷ average operating outflow" tone="runway" />
    </section>

    <section className="bankDashboardGrid primaryCharts">
      <article className="controlCard bankChartCard cashFlowCard">
        <header className="bankPanelHeader"><div><p className="eyebrow">Cash-flow trend</p><h2>{financial?.range.interval === "day" ? "Daily" : financial?.range.interval === "week" ? "Weekly" : "Monthly"} cash movement</h2><span>Operating inflows and outflows exclude detected internal transfers and credit-card settlements.</span></div><strong className={(summary?.netCashFlow || 0) >= 0 ? "positiveText" : "negativeText"}>{money(summary?.netCashFlow || 0)} net</strong></header>
        <CashFlowChart data={financial?.trend || []} />
      </article>

      <article className="controlCard bankInsightsCard">
        <header className="bankPanelHeader"><div><p className="eyebrow">What needs attention</p><h2>Financial insights</h2><span>Rule-based observations from the selected and prior periods.</span></div></header>
        <div className="bankInsightList">
          {(financial?.insights || []).map((insight) => <div className={`bankInsight ${insight.tone}`} key={insight.id}>
            <div><strong>{insight.title}</strong><p>{insight.detail}</p></div>{insight.metric && <span>{insight.metric}</span>}
          </div>)}
          {!financial?.insights.length && <div className="bankChartEmpty">More transaction history is needed before useful insights can be calculated.</div>}
        </div>
      </article>
    </section>

    <section className="bankDashboardGrid spendingCharts">
      <article className="controlCard bankChartCard">
        <header className="bankPanelHeader"><div><p className="eyebrow">Where cash went</p><h2>Operating outflows by category</h2><span>Current period with change against the immediately prior period.</span></div><strong>{money(summary?.outflows || 0)}</strong></header>
        <CategoryBars data={financial?.categories || []} total={summary?.outflows || 0} />
      </article>

      <article className="controlCard bankMerchantCard">
        <header className="bankPanelHeader"><div><p className="eyebrow">Payee concentration</p><h2>Top merchants and vendors</h2><span>Transfers and card settlements are excluded.</span></div></header>
        <div className="merchantList">
          {(financial?.merchants || []).slice(0, 10).map((merchant, index) => <div key={merchant.merchant}>
            <span className="merchantRank">{index + 1}</span>
            <div><strong>{merchant.merchant}</strong><span>{merchant.category} · {merchant.count} transaction{merchant.count === 1 ? "" : "s"}</span></div>
            <b>{money(merchant.amount)}</b>
          </div>)}
          {!financial?.merchants.length && <div className="bankChartEmpty">No vendor spending is available for this period.</div>}
        </div>
      </article>
    </section>

    <section className="bankDashboardGrid accountAndHealth">
      <article className="controlCard bankAccountsPanel">
        <header className="bankPanelHeader"><div><p className="eyebrow">Balance sheet snapshot</p><h2>Connected accounts</h2><span>Current balances are the latest values supplied by Plaid or the imported running balance.</span></div><a href={`/ops/bank-accounts?business=${encodeURIComponent(business)}`}>Manage accounts</a></header>
        <div className="bankAccountGrid">
          {(financial?.accounts || []).map((account) => <div className={`bankAccountTile ${/credit|card/i.test(`${account.accountType} ${account.accountSubtype}`) ? "credit" : "deposit"}`} key={account.id}>
            <div><strong>{account.name}</strong><span>{account.institutionName}{account.mask ? ` · •••• ${account.mask}` : ""}</span></div>
            <b>{account.currentBalance === null ? "Balance unavailable" : money(account.currentBalance)}</b>
            <small>{account.availableBalance === null ? `${account.accountSubtype || account.accountType}` : `${money(account.availableBalance)} available`} · updated {new Date(account.updatedAt).toLocaleDateString()}</small>
          </div>)}
          {!financial?.accounts.length && <div className="bankChartEmpty">No active bank or card accounts are available.</div>}
        </div>
      </article>

      <article className="controlCard bankHealthPanel">
        <header className="bankPanelHeader"><div><p className="eyebrow">Bookkeeping health</p><h2>Reconciliation and coding</h2><span>How complete and current the underlying banking data is.</span></div></header>
        <div className="healthMeters">
          <div><span>Transactions coded</span><strong>{summary?.codingPercent || 0}%</strong><i><b style={{ width: `${summary?.codingPercent || 0}%` }} /></i><small>{summary?.uncategorizedCount || 0} uncategorized · {money(summary?.uncategorizedAmount || 0)}</small></div>
          <div><span>Transactions posted</span><strong>{summary?.postingPercent || 0}%</strong><i><b style={{ width: `${summary?.postingPercent || 0}%` }} /></i><small>{summary?.postedCount || 0} of {summary?.transactionCount || 0} posted</small></div>
          <div><span>Card statements matched</span><strong>{financial ? Math.round(financial.reconciliation.matchedStatements / Math.max(1, financial.reconciliation.matchedStatements + financial.reconciliation.unmatchedStatements) * 100) : 0}%</strong><i><b style={{ width: `${financial ? Math.round(financial.reconciliation.matchedStatements / Math.max(1, financial.reconciliation.matchedStatements + financial.reconciliation.unmatchedStatements) * 100) : 0}%` }} /></i><small>{financial?.reconciliation.unmatchedStatements || 0} still unmatched</small></div>
        </div>
        <div className="connectionHealth">
          {(financial?.reconciliation.connections || []).map((connection) => <div className={connection.stale ? "stale" : "current"} key={connection.id}><span>{connection.provider}</span><strong>{connection.institutionName}</strong><small>{connection.lastSyncAt ? `Last sync ${new Date(connection.lastSyncAt).toLocaleString()}` : "Never synchronized"}</small></div>)}
          {!financial?.reconciliation.connections.length && <div className="bankChartEmpty">No active bank connections.</div>}
        </div>
      </article>
    </section>

    <section className="controlCard bankAnomalyPanel">
      <header className="bankPanelHeader"><div><p className="eyebrow">Exception review</p><h2>Large or unusual outflows</h2><span>Outflows at least $500 and roughly three times the median transaction for this period.</span></div><strong>{financial?.anomalies.length || 0} flagged</strong></header>
      <div className="bankAnomalyTableWrap"><table className="bankAnomalyTable"><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Account</th><th>Why flagged</th><th>Amount</th></tr></thead><tbody>
        {(financial?.anomalies || []).map((item) => <tr key={item.id}><td>{item.date}</td><td><strong>{item.merchant}</strong><span>{item.description}</span></td><td>{item.category}</td><td>{item.accountName}</td><td>{item.reason}</td><td><strong>{money(item.amount)}</strong></td></tr>)}
        {!financial?.anomalies.length && <tr><td colSpan={6}>No large-transaction exceptions were detected for this period.</td></tr>}
      </tbody></table></div>
    </section>

    <section className="bankingQuickLinks">
      <a className="primary" href={`/ops/accounting-control?business=${encodeURIComponent(business)}`}><strong>Code transactions</strong><span>Splits, invoices, recurring billing, and reconciliation</span></a>
      <a href={`/ops/expense-control?business=${encodeURIComponent(business)}`}><strong>Cards & receipts</strong><span>Receipt OCR and card-payment matching</span></a>
      <a href={`/ops/card-statements?business=${encodeURIComponent(business)}`}><strong>Card statements</strong><span>Upload statements and confirm bank payments</span></a>
      <a href={`/ops/integrations?business=${encodeURIComponent(business)}`}><strong>Bank connections</strong><span>Plaid, CSV history, account selection, and sync status</span></a>
    </section>

    <section className="controlCard bankingApproval">
      <div className="bankingApprovalHeader">
        <div><p className="eyebrow">Transaction coding queue</p><h2>Suggested coding</h2><p>{data?.summary.totalUnposted || 0} unposted transaction{data?.summary.totalUnposted === 1 ? "" : "s"}. Only single-account suggestions are eligible for bulk approval; split deposits and invoice allocations still require manual coding.</p></div>
        <div className="bankingApprovalActions">
          <button type="button" onClick={() => setShowCoding((value) => !value)}>{showCoding ? "Hide queue" : "Show queue"}</button>
          <label>Minimum confidence<select value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))}><option value="0.8">80%</option><option value="0.85">85%</option><option value="0.9">90%</option><option value="0.95">95%</option></select></label>
          <button onClick={() => setSelected(eligible.map((item) => item.id))}>Select eligible</button>
          <button className="primary" disabled={busy || selected.length === 0} onClick={() => void apply(selected)}>Approve selected ({selected.length})</button>
        </div>
      </div>

      <div className="codingSummaryStrip">
        <div><span>High confidence</span><strong>{data?.summary.highConfidence || 0}</strong></div>
        <div><span>Needs judgment</span><strong>{(data?.summary.mediumConfidence || 0) + (data?.summary.lowConfidence || 0)}</strong></div>
        <div><span>No suggestion</span><strong>{data?.summary.noSuggestion || 0}</strong></div>
        <div><span>Learned examples</span><strong>{data?.summary.learnedExamples || 0}</strong></div>
      </div>

      {showCoding && <div className="bankSuggestionList">
        {(data?.suggestions || []).map((item) => {
          const selectable = !item.pending && Boolean(item.accountCode) && item.confidence >= minimumConfidence;
          return <article className={`bankSuggestion ${item.confidenceBand.toLowerCase()}`} key={item.id}>
            <input type="checkbox" aria-label={`Select ${item.merchantName || item.description}`} disabled={!selectable || busy} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
            <div className="bankSuggestionTransaction"><strong>{item.merchantName || item.description || "Bank transaction"}</strong><span>{item.transactionDate} · {item.description}</span><b className={item.signedAmount >= 0 ? "in" : "out"}>{money(item.signedAmount, 2)}</b></div>
            <div className="bankSuggestionCode"><span>{item.accountCode ? `${item.accountCode} · ${item.accountName}` : "No coding suggestion"}</span><small>{item.category || item.source}</small></div>
            <div className="bankConfidence"><strong>{item.confidencePercent}%</strong><div><i style={{ width: `${item.confidencePercent}%` }} /></div><small>{item.confidenceBand} · {item.source}</small></div>
          </article>;
        })}
        {!data?.suggestions.length && <p>No unposted transactions are waiting for coding.</p>}
      </div>}
    </section>

    {financial && <p className="bankGenerated">Dashboard updated {new Date(financial.generatedAt).toLocaleString()}. Cash-flow reporting excludes detected transfers and credit-card settlements; balances and transaction history remain dependent on the connected/imported data available.</p>}
  </main>;
}
