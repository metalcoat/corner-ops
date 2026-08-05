"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";
import "./finance-operations.css";

type Tab = "briefing" | "forecast" | "bills" | "inventory" | "labor" | "profitability" | "statements";

type ActionItem = { priority: "Critical" | "Warning" | "Opportunity" | "Info"; title: string; detail: string; href: string };
type ForecastWeek = {
  weekStart: string;
  weekEnd: string;
  openingCash: number;
  baselineInflows: number;
  baselineOperatingOutflows: number;
  payroll: number;
  bills: number;
  manualInflows: number;
  manualOutflows: number;
  endingCash: number;
  belowMinimum: boolean;
  details: Array<{ type: string; date: string; description: string; amount: number }>;
};
type Bill = {
  id: string;
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: number;
  category: string;
  accountCode: string;
  status: string;
  notes: string;
  fileName: string;
  hasFile: boolean;
  overdue: boolean;
  daysUntilDue: number;
  candidates: Array<{ id: string; date: string; merchant: string; description: string; amount: number }>;
};
type InventoryItem = {
  id: string;
  name: string;
  category: string;
  baseUnit: string;
  parQuantity: number;
  currentQuantity: number;
  reorderPoint: number;
  preferredVendor: string;
  needsReorder: boolean;
  latestPrice: number | null;
  latestVendor: string;
  latestDate: string | null;
  priorPrice: number | null;
  priceChangePercent: number | null;
  bestRecentVendor: string;
  bestRecentPrice: number | null;
  potentialSavingsPerUnit: number;
};
type Recipe = {
  id: string;
  productName: string;
  yieldQuantity: number;
  sellingPrice: number;
  totalBatchCost: number | null;
  unitCost: number | null;
  foodCostPercent: number | null;
  contributionMargin: number | null;
  recommendedPriceAt30Percent: number | null;
  complete: boolean;
  components: Array<{ id: string; itemName: string; quantity: number; unit: string; wastePercent: number; cost: number | null; compatibleUnits: boolean }>;
};
type LaborDay = {
  date: string;
  sales: number;
  orders: number;
  laborHours: number;
  laborCost: number;
  salesPerLaborHour: number;
  ordersPerLaborHour: number;
  laborCostPercent: number | null;
  weekday: string;
};
type ProductRow = {
  product: string;
  quantity: number;
  sales: number;
  averagePrice: number;
  recipeCost: number | null;
  estimatedCost: number | null;
  contribution: number | null;
  marginPercent: number | null;
  costCoverage: string;
};
type StatementAccount = {
  code: string;
  name: string;
  accountType: string;
  periodDebit: number;
  periodCredit: number;
  periodBalance: number;
  priorBalance: number;
  endingDebit: number;
  endingCredit: number;
  endingBalance: number;
};
type Dashboard = {
  business: Business;
  range: { start: string; end: string };
  generatedAt: string;
  briefing: {
    generatedAt: string;
    headline: { currentCash: number; forecastEndingCash: number; openBills: number; netIncome: number; laborCostPercent: number | null; contribution: number };
    actions: ActionItem[];
  };
  forecast: {
    assumptions: { minimumCash: number; historicalWeeklyInflows: number; historicalWeeklyOperatingOutflows: number; historicalWeeklyPayroll: number };
    summary: { currentCash: number; endingCash: number; lowestCash: number; lowestWeek: string; firstBelowMinimumWeek: string | null; openBillsInForecast: number; payrollInForecast: number };
    weeks: ForecastWeek[];
    events: Array<{ id: string; event_date: string; description: string; amount: number; direction: string; recurrence: string }>;
  };
  bills: {
    summary: { totalOpen: number; overdue: number; overdueCount: number; due7Days: number; due30Days: number; openCount: number; paidCount: number };
    bills: Bill[];
  };
  inventory: {
    summary: { activeItems: number; reorderCount: number; priceIncreaseCount: number; recipes: number; incompleteRecipes: number; potentialSavings: number };
    items: InventoryItem[];
    recipes: Recipe[];
  };
  labor: {
    summary: { totalSales: number; totalOrders: number; totalLaborHours: number; totalLaborCost: number; salesPerLaborHour: number; ordersPerLaborHour: number; laborCostPercent: number | null };
    daily: LaborDay[];
    weekdays: Array<{ weekday: string; days: number; averageSales: number; averageLaborHours: number; salesPerLaborHour: number; laborCostPercent: number | null; ordersPerLaborHour: number }>;
    exceptions: Array<LaborDay & { reason: string }>;
  };
  profitability: {
    summary: { products: number; sales: number; estimatedCost: number; contribution: number; recipeCoveragePercent: number };
    products: ProductRow[];
    dayparts: Array<{ daypart: string; orders: number; sales: number }>;
    daypartCoverage: string;
  };
  statements: {
    range: { start: string; end: string; priorStart: string; priorEnd: string };
    profitAndLoss: { revenue: StatementAccount[]; expenses: StatementAccount[]; totalRevenue: number; totalExpenses: number; netIncome: number; priorRevenue: number; priorExpenses: number; priorNetIncome: number; grossMarginPercent: number | null };
    balanceSheet: { assets: StatementAccount[]; liabilities: StatementAccount[]; equity: StatementAccount[]; retainedEarnings: number; totalAssets: number; totalLiabilities: number; statedEquity: number; totalEquity: number; balanceDifference: number; balanced: boolean };
    cashFlow: { directMonthly: Array<{ month: string; cashIn: number; cashOut: number; netCash: number }>; cashIn: number; cashOut: number; netCash: number; method: string };
    trialBalance: { accounts: StatementAccount[]; totalDebits: number; totalCredits: number };
    entrySummary: Array<{ id: string; date: string; description: string; source: string; reference: string; debit: number; credit: number; lines: number }>;
  };
};

type BillLineDraft = { inventoryItemId: string; description: string; quantity: string; unit: string; unitPrice: string };

const tabLabels: Array<[Tab, string]> = [
  ["briefing", "Owner briefing"],
  ["forecast", "13-week forecast"],
  ["bills", "Bills & A/P"],
  ["inventory", "Inventory & recipes"],
  ["labor", "Labor productivity"],
  ["profitability", "Product profitability"],
  ["statements", "Financial statements"],
];

function money(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value || 0);
}

function number(value: number, digits = 1) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value || 0);
}

function percent(value: number | null) {
  return value === null ? "Unavailable" : `${number(value, 1)}%`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ytdStart() {
  return `${new Date().getFullYear()}-01-01`;
}

async function responseMessage(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error || `Request failed (${response.status}).`;
}

function classForAmount(value: number) {
  return value >= 0 ? "positiveText" : "negativeText";
}

function CashForecastChart({ weeks, minimum }: { weeks: ForecastWeek[]; minimum: number }) {
  if (!weeks.length) return <div className="foEmpty">No forecast points are available.</div>;
  const width = 980;
  const height = 280;
  const left = 70;
  const right = 24;
  const top = 24;
  const bottom = 44;
  const values = weeks.flatMap((week) => [week.openingCash, week.endingCash, minimum]);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const span = max - min || 1;
  const y = (value: number) => top + (max - value) / span * (height - top - bottom);
  const step = (width - left - right) / Math.max(1, weeks.length - 1);
  const points = weeks.map((week, index) => `${left + index * step},${y(week.endingCash)}`).join(" ");
  return <div className="foChartScroll"><svg className="foForecastChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Thirteen week ending cash forecast">
    {[0, .25, .5, .75, 1].map((ratio) => {
      const value = min + span * ratio;
      return <g key={ratio}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="foGridLine" /><text x={left - 8} y={y(value) + 4} textAnchor="end" className="foAxisText">{money(value)}</text></g>;
    })}
    <line x1={left} x2={width - right} y1={y(minimum)} y2={y(minimum)} className="foMinimumLine" />
    <polyline points={points} fill="none" className="foCashLine" />
    {weeks.map((week, index) => <g key={week.weekEnd}><circle cx={left + index * step} cy={y(week.endingCash)} r="5" className={week.belowMinimum ? "foCashPoint danger" : "foCashPoint"}><title>{`${week.weekEnd}: ${money(week.endingCash, 2)}`}</title></circle><text x={left + index * step} y={height - 17} textAnchor="middle" className="foAxisText">{new Date(`${week.weekEnd}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}</text></g>)}
  </svg></div>;
}

function Metric({ label, value, detail, tone = "" }: { label: string; value: string; detail?: string; tone?: string }) {
  return <article className={`foMetric ${tone}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>;
}

export default function FinanceOperationsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [tab, setTab] = useState<Tab>("briefing");
  const [start, setStart] = useState(ytdStart);
  const [end, setEnd] = useState(today);
  const [salesAdjustment, setSalesAdjustment] = useState(0);
  const [expenseAdjustment, setExpenseAdjustment] = useState(0);
  const [minimumCash, setMinimumCash] = useState(20000);
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [billLines, setBillLines] = useState<BillLineDraft[]>([{ inventoryItemId: "", description: "", quantity: "1", unit: "each", unitPrice: "" }]);
  const [selectedPayments, setSelectedPayments] = useState<Record<string, string>>({});

  useEffect(() => {
    const hash = window.location.hash.replace("#", "") as Tab;
    if (tabLabels.some(([value]) => value === hash)) setTab(hash);
    const saved = window.localStorage.getItem("corner-ops-business-theme");
    if (saved === "Tiki" || saved === "Corner Deli") setBusiness(saved);
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    const url = new URL(window.location.href);
    url.searchParams.set("business", business);
    window.history.replaceState(null, "", url);
  }, [business]);

  async function load(activeBusiness = business) {
    setBusy(true);
    try {
      const params = new URLSearchParams({
        business: activeBusiness,
        start,
        end,
        salesAdjustmentPercent: String(salesAdjustment),
        expenseAdjustmentPercent: String(expenseAdjustment),
        minimumCash: String(minimumCash),
      });
      const response = await fetch(`/api/finance-operations?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      setData(await response.json() as Dashboard);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void load(business).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, session?.authenticated]);

  async function post(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, business }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The finance operation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("action", "create-bill");
    form.set("business", business);
    form.set("lines", JSON.stringify(billLines.filter((line) => line.description.trim()).map((line) => ({
      inventoryItemId: line.inventoryItemId || null,
      description: line.description,
      quantity: Number(line.quantity || 1),
      unit: line.unit,
      unitPrice: Number(line.unitPrice || 0),
    }))));
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/finance-operations", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      formElement.reset();
      setBillLines([{ inventoryItemId: "", description: "", quantity: "1", unit: "each", unitPrice: "" }]);
      await load();
      setNotice("Vendor bill added and checked for duplicates.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Bill upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function changeTab(next: Tab) {
    setTab(next);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${next}`);
  }

  const inventoryOptions = data?.inventory.items || [];
  const recipeOptions = data?.inventory.recipes || [];
  const allowed = session?.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  if (!session) return <main className="controlPage foPage">Loading finance and operations…</main>;
  if (!session.authenticated) return <main className="controlPage foPage"><a href="/signin">Sign in to Corner Ops</a></main>;

  return <main className="controlPage foPage">
    <header className="controlHeader foHero">
      <div><p className="eyebrow">Finance and operations</p><h1>{business} command center</h1><p>Cash forecasting, payables, ingredient costs, recipe margins, labor productivity, financial statements, and the daily owner briefing all use the same underlying books and operating data.</p></div>
      <div className="controlActions"><div className="businessPills">{allowed.map((name) => <button key={name} className={business === name ? "active" : ""} onClick={() => setBusiness(name)}>{name}</button>)}</div><button disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh"}</button></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <section className="controlCard foRangeBar">
      <div><label>Start<input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} /></label><label>End<input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} /></label><button className="primary" disabled={busy} onClick={() => void load()}>Apply reporting period</button></div>
      <span>Statements, labor, and profitability use this period. The cash forecast always covers the next 13 weeks.</span>
    </section>

    <nav className="foTabs" aria-label="Finance and operations sections">{tabLabels.map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => changeTab(value)}>{label}</button>)}</nav>

    {!data && <section className="controlCard foEmpty">Loading operational intelligence…</section>}

    {data && tab === "briefing" && <section className="foSection" id="briefing">
      <div className="foMetricGrid six">
        <Metric label="Connected cash" value={money(data.briefing.headline.currentCash)} />
        <Metric label="13-week ending cash" value={money(data.briefing.headline.forecastEndingCash)} tone={data.briefing.headline.forecastEndingCash < minimumCash ? "danger" : "positive"} />
        <Metric label="Open bills" value={money(data.briefing.headline.openBills)} />
        <Metric label="Net income" value={money(data.briefing.headline.netIncome)} tone={data.briefing.headline.netIncome >= 0 ? "positive" : "danger"} />
        <Metric label="Labor cost" value={percent(data.briefing.headline.laborCostPercent)} />
        <Metric label="Product contribution" value={money(data.briefing.headline.contribution)} />
      </div>
      <article className="controlCard foBriefingCard"><header className="foPanelHeader"><div><p className="eyebrow">Owner briefing</p><h2>What needs attention</h2><span>Generated {new Date(data.briefing.generatedAt).toLocaleString()}</span></div></header><div className="foActionList">{data.briefing.actions.map((action, index) => <a href={action.href} className={`foAction ${action.priority.toLowerCase()}`} key={`${action.title}-${index}`}><span>{action.priority}</span><div><strong>{action.title}</strong><p>{action.detail}</p></div><b>Review →</b></a>)}</div></article>
    </section>}

    {data && tab === "forecast" && <section className="foSection" id="forecast">
      <section className="controlCard foScenario"><div><p className="eyebrow">Scenario controls</p><h2>13-week cash forecast</h2><p>Historical operating cash flow is adjusted by the scenario, while scheduled payroll, open bills, and manual events remain separately visible.</p></div><div className="foScenarioInputs"><label>Sales adjustment<input type="number" value={salesAdjustment} step="1" onChange={(event) => setSalesAdjustment(Number(event.target.value))} /><span>%</span></label><label>Expense adjustment<input type="number" value={expenseAdjustment} step="1" onChange={(event) => setExpenseAdjustment(Number(event.target.value))} /><span>%</span></label><label>Minimum cash<input type="number" value={minimumCash} step="1000" min="0" onChange={(event) => setMinimumCash(Number(event.target.value))} /></label><button className="primary" disabled={busy} onClick={() => void load()}>Recalculate</button></div></section>
      <div className="foMetricGrid four"><Metric label="Current cash" value={money(data.forecast.summary.currentCash)} /><Metric label="Ending cash" value={money(data.forecast.summary.endingCash)} tone={data.forecast.summary.endingCash >= minimumCash ? "positive" : "danger"} /><Metric label="Lowest point" value={money(data.forecast.summary.lowestCash)} detail={`Week ending ${data.forecast.summary.lowestWeek}`} /><Metric label="Known bills + payroll" value={money(data.forecast.summary.openBillsInForecast + data.forecast.summary.payrollInForecast)} /></div>
      <article className="controlCard"><CashForecastChart weeks={data.forecast.weeks} minimum={minimumCash} /></article>
      <div className="foTwoColumn">
        <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Known events</p><h2>Add forecast event</h2></div></header><form className="foForm" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void post({ action: "create-forecast-event", eventDate: form.get("eventDate"), description: form.get("description"), amount: form.get("amount"), direction: form.get("direction"), recurrence: form.get("recurrence") }, "Forecast event added."); event.currentTarget.reset(); }}><label>Date<input name="eventDate" type="date" required /></label><label>Description<input name="description" placeholder="Equipment payment, event deposit…" required /></label><label>Amount<input name="amount" type="number" step="0.01" min="0.01" required /></label><label>Direction<select name="direction"><option>Outflow</option><option>Inflow</option></select></label><label>Repeats<select name="recurrence"><option>None</option><option>Weekly</option><option>Monthly</option></select></label><button className="primary" disabled={busy}>Add event</button></form><div className="foCompactList">{data.forecast.events.map((event) => <div key={event.id}><div><strong>{event.description}</strong><span>{event.event_date} · {event.direction} · {event.recurrence}</span></div><b>{money(event.amount, 2)}</b><button onClick={() => void post({ action: "delete-forecast-event", eventId: event.id }, "Forecast event removed.")}>Remove</button></div>)}{!data.forecast.events.length && <p>No manual forecast events.</p>}</div></article>
        <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Weekly detail</p><h2>Forecast schedule</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Week</th><th>Inflows</th><th>Operating</th><th>Payroll</th><th>Bills</th><th>Ending cash</th></tr></thead><tbody>{data.forecast.weeks.map((week) => <tr className={week.belowMinimum ? "dangerRow" : ""} key={week.weekEnd}><td>{week.weekStart}<br /><small>to {week.weekEnd}</small></td><td>{money(week.baselineInflows + week.manualInflows)}</td><td>{money(week.baselineOperatingOutflows + week.manualOutflows)}</td><td>{money(week.payroll)}</td><td>{money(week.bills)}</td><td><strong>{money(week.endingCash)}</strong></td></tr>)}</tbody></table></div></article>
      </div>
    </section>}

    {data && tab === "bills" && <section className="foSection" id="bills">
      <div className="foMetricGrid four"><Metric label="Open bills" value={money(data.bills.summary.totalOpen)} detail={`${data.bills.summary.openCount} bills`} /><Metric label="Overdue" value={money(data.bills.summary.overdue)} detail={`${data.bills.summary.overdueCount} bills`} tone={data.bills.summary.overdueCount ? "danger" : "positive"} /><Metric label="Due in 7 days" value={money(data.bills.summary.due7Days)} /><Metric label="Due in 30 days" value={money(data.bills.summary.due30Days)} /></div>
      <div className="foTwoColumn billLayout">
        <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Accounts payable</p><h2>Add vendor bill</h2><span>Invoice number and vendor are checked for duplicates.</span></div></header><form className="foForm" onSubmit={submitBill}><input type="hidden" name="subtotal" value="0" /><label>Vendor<input name="vendor" required /></label><label>Invoice number<input name="invoiceNumber" /></label><label>Invoice date<input name="invoiceDate" type="date" required /></label><label>Due date<input name="dueDate" type="date" required /></label><label>Total amount<input name="totalAmount" type="number" step="0.01" min="0.01" required /></label><label>Tax amount<input name="taxAmount" type="number" step="0.01" min="0" defaultValue="0" /></label><label>Category<input name="category" defaultValue="Other Expense" /></label><label>Account code<input name="accountCode" defaultValue="5900" /></label><label className="full">Notes<textarea name="notes" rows={3} /></label><label className="full">Invoice or receipt<input name="file" type="file" accept=".pdf,.csv,.xlsx,.xls,.jpg,.jpeg,.png,.webp" /></label><div className="full foBillLines"><div className="foPanelHeader"><div><strong>Optional inventory lines</strong><span>Inventory-linked lines also update price history and on-hand quantity.</span></div><button type="button" onClick={() => setBillLines((lines) => [...lines, { inventoryItemId: "", description: "", quantity: "1", unit: "each", unitPrice: "" }])}>Add line</button></div>{billLines.map((line, index) => <div className="foBillLine" key={index}><select value={line.inventoryItemId} onChange={(event) => setBillLines((lines) => lines.map((item, itemIndex) => itemIndex === index ? { ...item, inventoryItemId: event.target.value } : item))}><option value="">No inventory item</option>{inventoryOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><input placeholder="Description" value={line.description} onChange={(event) => setBillLines((lines) => lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /><input aria-label="Quantity" type="number" step="0.0001" min="0" value={line.quantity} onChange={(event) => setBillLines((lines) => lines.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: event.target.value } : item))} /><input aria-label="Unit" value={line.unit} onChange={(event) => setBillLines((lines) => lines.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value } : item))} /><input aria-label="Unit price" type="number" step="0.0001" min="0" value={line.unitPrice} onChange={(event) => setBillLines((lines) => lines.map((item, itemIndex) => itemIndex === index ? { ...item, unitPrice: event.target.value } : item))} /><button type="button" onClick={() => setBillLines((lines) => lines.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div><button className="primary full" disabled={busy}>Save bill</button></form></article>
        <section className="foBillList">{data.bills.bills.map((bill) => <article className={`controlCard foBill ${bill.overdue ? "overdue" : ""}`} key={bill.id}><header><div><p className="eyebrow">{bill.status} · Due {bill.dueDate}</p><h2>{bill.vendor}</h2><span>{bill.invoiceNumber || "No invoice number"} · {bill.category}</span></div><strong>{money(bill.totalAmount, 2)}</strong></header>{bill.notes && <p>{bill.notes}</p>}<div className="foBillActions">{bill.hasFile && <a href={`/api/finance-operations/bills/${bill.id}/download`}>Download {bill.fileName}</a>}{bill.status === "Open" && bill.candidates.length > 0 && <><select value={selectedPayments[bill.id] || bill.candidates[0].id} onChange={(event) => setSelectedPayments((current) => ({ ...current, [bill.id]: event.target.value }))}>{bill.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.date} · {money(candidate.amount, 2)} · {candidate.merchant}</option>)}</select><button className="primary" disabled={busy} onClick={() => void post({ action: "bill-status", billId: bill.id, status: "Paid", bankTransactionId: selectedPayments[bill.id] || bill.candidates[0].id }, "Bill matched and marked paid.")}>Match payment</button></>}{bill.status === "Open" && <button disabled={busy} onClick={() => void post({ action: "bill-status", billId: bill.id, status: "Void" }, "Bill voided.")}>Void</button>}</div></article>)}{!data.bills.bills.length && <article className="controlCard foEmpty">No vendor bills have been entered.</article>}</section>
      </div>
    </section>}

    {data && tab === "inventory" && <section className="foSection" id="inventory">
      <div className="foMetricGrid five"><Metric label="Inventory items" value={String(data.inventory.summary.activeItems)} /><Metric label="At reorder point" value={String(data.inventory.summary.reorderCount)} tone={data.inventory.summary.reorderCount ? "danger" : "positive"} /><Metric label="Price increases ≥5%" value={String(data.inventory.summary.priceIncreaseCount)} /><Metric label="Costed recipes" value={String(data.inventory.summary.recipes)} /><Metric label="Potential replenishment savings" value={money(data.inventory.summary.potentialSavings)} /></div>
      <div className="foThreeColumn">
        <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Inventory master</p><h2>Add or update item</h2></div></header><form className="foForm single" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void post({ action: "create-inventory-item", name: form.get("name"), category: form.get("category"), baseUnit: form.get("baseUnit"), parQuantity: form.get("parQuantity"), currentQuantity: form.get("currentQuantity"), reorderPoint: form.get("reorderPoint"), preferredVendor: form.get("preferredVendor") }, "Inventory item saved."); event.currentTarget.reset(); }}><label>Name<input name="name" required /></label><label>Category<input name="category" /></label><label>Base unit<input name="baseUnit" defaultValue="each" required /></label><label>Par quantity<input name="parQuantity" type="number" step="0.0001" min="0" /></label><label>Current quantity<input name="currentQuantity" type="number" step="0.0001" min="0" /></label><label>Reorder point<input name="reorderPoint" type="number" step="0.0001" min="0" /></label><label>Preferred vendor<input name="preferredVendor" /></label><button className="primary" disabled={busy}>Save item</button></form></article>
        <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Vendor price history</p><h2>Record purchase</h2></div></header><form className="foForm single" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void post({ action: "record-inventory-purchase", inventoryItemId: form.get("inventoryItemId"), vendor: form.get("vendor"), purchaseDate: form.get("purchaseDate"), quantity: form.get("quantity"), unit: form.get("unit"), unitPrice: form.get("unitPrice"), source: "Manual purchase" }, "Purchase and price history recorded."); event.currentTarget.reset(); }}><label>Item<select name="inventoryItemId" required><option value="">Choose item</option>{inventoryOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Vendor<input name="vendor" required /></label><label>Purchase date<input name="purchaseDate" type="date" required /></label><label>Quantity<input name="quantity" type="number" step="0.0001" min="0.0001" required /></label><label>Purchase unit<input name="unit" defaultValue="each" required /></label><label>Unit price<input name="unitPrice" type="number" step="0.0001" min="0.0001" required /></label><button className="primary" disabled={busy}>Record purchase</button></form></article>
        <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Recipe costing</p><h2>Create recipe</h2></div></header><form className="foForm single" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void post({ action: "create-recipe", productName: form.get("productName"), yieldQuantity: form.get("yieldQuantity"), sellingPrice: form.get("sellingPrice") }, "Recipe saved."); event.currentTarget.reset(); }}><label>Product name<input name="productName" required /></label><label>Recipe yield<input name="yieldQuantity" type="number" step="0.0001" min="0.0001" defaultValue="1" required /></label><label>Selling price<input name="sellingPrice" type="number" step="0.01" min="0" /></label><button className="primary" disabled={busy}>Save recipe</button></form><hr /><form className="foForm single" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void post({ action: "add-recipe-component", recipeId: form.get("recipeId"), inventoryItemId: form.get("inventoryItemId"), quantity: form.get("quantity"), unit: form.get("unit"), wastePercent: form.get("wastePercent") }, "Recipe component saved."); event.currentTarget.reset(); }}><label>Recipe<select name="recipeId" required><option value="">Choose recipe</option>{recipeOptions.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.productName}</option>)}</select></label><label>Ingredient<select name="inventoryItemId" required><option value="">Choose inventory item</option>{inventoryOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Quantity<input name="quantity" type="number" step="0.0001" min="0.0001" required /></label><label>Unit<input name="unit" defaultValue="each" required /></label><label>Waste %<input name="wastePercent" type="number" min="0" max="99" step="0.1" defaultValue="0" /></label><button disabled={busy}>Add ingredient</button></form></article>
      </div>
      <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Price intelligence</p><h2>Ingredient and supply costs</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Item</th><th>On hand / reorder</th><th>Latest price</th><th>Change</th><th>Best recent vendor</th><th>Action</th></tr></thead><tbody>{data.inventory.items.map((item) => <tr className={item.needsReorder ? "dangerRow" : ""} key={item.id}><td><strong>{item.name}</strong><small>{item.category} · per {item.baseUnit}</small></td><td>{number(item.currentQuantity, 2)} / {number(item.reorderPoint, 2)}</td><td>{item.latestPrice === null ? "No purchase data" : `${money(item.latestPrice, 4)} · ${item.latestVendor}`}</td><td className={(item.priceChangePercent || 0) > 0 ? "negativeText" : "positiveText"}>{item.priceChangePercent === null ? "—" : `${item.priceChangePercent > 0 ? "+" : ""}${item.priceChangePercent}%`}</td><td>{item.bestRecentVendor ? `${item.bestRecentVendor} · ${money(item.bestRecentPrice || 0, 4)}` : "—"}</td><td><button onClick={() => { const value = window.prompt(`Current quantity for ${item.name}`, String(item.currentQuantity)); if (value !== null) void post({ action: "adjust-inventory", inventoryItemId: item.id, currentQuantity: value }, "Inventory quantity updated."); }}>Count</button></td></tr>)}</tbody></table></div></article>
      <section className="foRecipeGrid">{data.inventory.recipes.map((recipe) => <article className={`controlCard foRecipe ${recipe.complete ? "" : "incomplete"}`} key={recipe.id}><header><div><p className="eyebrow">{recipe.complete ? "Costed recipe" : "Needs cost data"}</p><h2>{recipe.productName}</h2></div><strong>{recipe.unitCost === null ? "—" : money(recipe.unitCost, 2)}</strong></header><div className="foRecipeMetrics"><span>Selling price <b>{money(recipe.sellingPrice, 2)}</b></span><span>Food cost <b>{percent(recipe.foodCostPercent)}</b></span><span>Margin <b>{recipe.contributionMargin === null ? "—" : money(recipe.contributionMargin, 2)}</b></span><span>30% target price <b>{recipe.recommendedPriceAt30Percent === null ? "—" : money(recipe.recommendedPriceAt30Percent, 2)}</b></span></div><div className="foCompactList">{recipe.components.map((component) => <div key={component.id}><div><strong>{component.itemName}</strong><span>{number(component.quantity, 4)} {component.unit} · {component.wastePercent}% waste</span></div><b>{component.cost === null ? "Unit mismatch / no price" : money(component.cost, 2)}</b><button onClick={() => void post({ action: "remove-recipe-component", recipeId: recipe.id, componentId: component.id }, "Recipe component removed.")}>×</button></div>)}{!recipe.components.length && <p>No ingredients added.</p>}</div></article>)}</section>
    </section>}

    {data && tab === "labor" && <section className="foSection" id="labor">
      <div className="foMetricGrid five"><Metric label="Sales" value={money(data.labor.summary.totalSales)} /><Metric label="Labor hours" value={`${number(data.labor.summary.totalLaborHours)}h`} /><Metric label="Estimated labor cost" value={money(data.labor.summary.totalLaborCost)} /><Metric label="Sales per labor hour" value={money(data.labor.summary.salesPerLaborHour)} /><Metric label="Labor cost %" value={percent(data.labor.summary.laborCostPercent)} tone={(data.labor.summary.laborCostPercent || 0) > 35 ? "danger" : ""} /></div>
      <div className="foTwoColumn"><article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Staffing pattern</p><h2>Productivity by weekday</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Day</th><th>Avg sales</th><th>Avg hours</th><th>Sales / hour</th><th>Orders / hour</th><th>Labor %</th></tr></thead><tbody>{data.labor.weekdays.map((row) => <tr key={row.weekday}><td>{row.weekday}<small>{row.days} observed</small></td><td>{money(row.averageSales)}</td><td>{number(row.averageLaborHours)}</td><td>{money(row.salesPerLaborHour)}</td><td>{number(row.ordersPerLaborHour, 2)}</td><td>{percent(row.laborCostPercent)}</td></tr>)}</tbody></table></div></article><article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Exceptions</p><h2>Days to review</h2></div></header><div className="foActionList">{data.labor.exceptions.map((row) => <div className="foAction warning" key={row.date}><span>{row.weekday}</span><div><strong>{new Date(`${row.date}T12:00:00`).toLocaleDateString()}</strong><p>{row.reason}</p></div><b>{money(row.salesPerLaborHour)}/hr</b></div>)}{!data.labor.exceptions.length && <div className="foEmpty">No material low-productivity days in the selected period.</div>}</div></article></div>
      <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Daily detail</p><h2>Sales and labor</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Date</th><th>Sales</th><th>Orders</th><th>Hours</th><th>Labor cost</th><th>Sales / hour</th><th>Labor %</th></tr></thead><tbody>{data.labor.daily.map((row) => <tr key={row.date}><td>{row.date}</td><td>{money(row.sales)}</td><td>{row.orders}</td><td>{number(row.laborHours)}</td><td>{money(row.laborCost)}</td><td>{money(row.salesPerLaborHour)}</td><td>{percent(row.laborCostPercent)}</td></tr>)}</tbody></table></div></article>
    </section>}

    {data && tab === "profitability" && <section className="foSection" id="profitability">
      <div className="foMetricGrid four"><Metric label="Product sales" value={money(data.profitability.summary.sales)} /><Metric label="Estimated ingredient cost" value={money(data.profitability.summary.estimatedCost)} /><Metric label="Contribution margin" value={money(data.profitability.summary.contribution)} /><Metric label="Complete recipe coverage" value={`${data.profitability.summary.recipeCoveragePercent}%`} tone={data.profitability.summary.recipeCoveragePercent < 80 ? "danger" : "positive"} /></div>
      <div className="foTwoColumn"><article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Dayparts</p><h2>Business by time of day</h2><span>{data.profitability.daypartCoverage === "Orders only" ? "Corner Deli product exports do not link item sales to order time, so dayparts show order volume only." : "Sales and order volume by local order time."}</span></div></header><div className="foDayparts">{data.profitability.dayparts.map((row) => <div key={row.daypart}><span>{row.daypart}</span><strong>{data.profitability.daypartCoverage === "Sales" ? money(row.sales) : `${row.orders} orders`}</strong><small>{row.orders} orders</small></div>)}</div></article><article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Coverage warning</p><h2>Margin confidence</h2></div></header><p className="foLargeText">Only products with complete recipe components and current ingredient prices receive a calculated contribution margin. Products without cost coverage remain visible instead of being assigned a fictional zero cost, because imaginary margins are how menus become expensive hobbies.</p></article></div>
      <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Product economics</p><h2>Sales, cost, and contribution</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Product</th><th>Qty</th><th>Sales</th><th>Avg price</th><th>Recipe cost</th><th>Contribution</th><th>Margin</th><th>Coverage</th></tr></thead><tbody>{data.profitability.products.map((row) => <tr key={row.product}><td><strong>{row.product}</strong></td><td>{number(row.quantity, 2)}</td><td>{money(row.sales)}</td><td>{money(row.averagePrice, 2)}</td><td>{row.recipeCost === null ? "—" : money(row.recipeCost, 2)}</td><td>{row.contribution === null ? "—" : money(row.contribution)}</td><td>{row.marginPercent === null ? "—" : `${row.marginPercent}%`}</td><td><span className={`foBadge ${row.costCoverage === "Complete" ? "good" : "warning"}`}>{row.costCoverage}</span></td></tr>)}</tbody></table></div></article>
    </section>}

    {data && tab === "statements" && <section className="foSection" id="statements">
      <div className="foMetricGrid four"><Metric label="Revenue" value={money(data.statements.profitAndLoss.totalRevenue)} detail={`Prior: ${money(data.statements.profitAndLoss.priorRevenue)}`} /><Metric label="Expenses" value={money(data.statements.profitAndLoss.totalExpenses)} detail={`Prior: ${money(data.statements.profitAndLoss.priorExpenses)}`} /><Metric label="Net income" value={money(data.statements.profitAndLoss.netIncome)} tone={data.statements.profitAndLoss.netIncome >= 0 ? "positive" : "danger"} /><Metric label="Balance check" value={data.statements.balanceSheet.balanced ? "Balanced" : money(data.statements.balanceSheet.balanceDifference)} tone={data.statements.balanceSheet.balanced ? "positive" : "danger"} /></div>
      <div className="foTwoColumn"><StatementPanel title="Profit & loss" leftTitle="Revenue" left={data.statements.profitAndLoss.revenue} rightTitle="Expenses" right={data.statements.profitAndLoss.expenses} leftTotal={data.statements.profitAndLoss.totalRevenue} rightTotal={data.statements.profitAndLoss.totalExpenses} footerLabel="Net income" footerValue={data.statements.profitAndLoss.netIncome} /><StatementPanel title={`Balance sheet as of ${data.statements.range.end}`} leftTitle="Assets" left={data.statements.balanceSheet.assets} rightTitle="Liabilities & equity" right={[...data.statements.balanceSheet.liabilities, ...data.statements.balanceSheet.equity, { code: "RE", name: "Current retained earnings", accountType: "Equity", periodDebit: 0, periodCredit: 0, periodBalance: 0, priorBalance: 0, endingDebit: 0, endingCredit: 0, endingBalance: data.statements.balanceSheet.retainedEarnings }]} leftTotal={data.statements.balanceSheet.totalAssets} rightTotal={data.statements.balanceSheet.totalLiabilities + data.statements.balanceSheet.totalEquity} footerLabel="Difference" footerValue={data.statements.balanceSheet.balanceDifference} /></div>
      <div className="foTwoColumn"><article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Direct method</p><h2>Cash movement</h2><span>{data.statements.cashFlow.method}</span></div></header><div className="foMetricGrid three"><Metric label="Cash in" value={money(data.statements.cashFlow.cashIn)} /><Metric label="Cash out" value={money(data.statements.cashFlow.cashOut)} /><Metric label="Net cash" value={money(data.statements.cashFlow.netCash)} tone={data.statements.cashFlow.netCash >= 0 ? "positive" : "danger"} /></div><div className="foTableWrap"><table><thead><tr><th>Month</th><th>Cash in</th><th>Cash out</th><th>Net</th></tr></thead><tbody>{data.statements.cashFlow.directMonthly.map((row) => <tr key={row.month}><td>{row.month}</td><td>{money(row.cashIn)}</td><td>{money(row.cashOut)}</td><td className={classForAmount(row.netCash)}>{money(row.netCash)}</td></tr>)}</tbody></table></div></article><article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Ledger integrity</p><h2>Trial balance</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Account</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>{data.statements.trialBalance.accounts.map((row) => <tr key={row.code}><td>{row.code} · {row.name}</td><td>{money(row.endingDebit, 2)}</td><td>{money(row.endingCredit, 2)}</td><td>{money(row.endingBalance, 2)}</td></tr>)}</tbody><tfoot><tr><th>Total</th><th>{money(data.statements.trialBalance.totalDebits, 2)}</th><th>{money(data.statements.trialBalance.totalCredits, 2)}</th><th>{money(data.statements.trialBalance.totalDebits - data.statements.trialBalance.totalCredits, 2)}</th></tr></tfoot></table></div></article></div>
      <article className="controlCard"><header className="foPanelHeader"><div><p className="eyebrow">Drill-down</p><h2>Journal entries</h2></div></header><div className="foTableWrap"><table><thead><tr><th>Date</th><th>Description</th><th>Source</th><th>Reference</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{data.statements.entrySummary.map((entry) => <tr key={entry.id}><td>{entry.date}</td><td>{entry.description}<small>{entry.lines} lines</small></td><td>{entry.source}</td><td>{entry.reference}</td><td>{money(entry.debit, 2)}</td><td>{money(entry.credit, 2)}</td></tr>)}</tbody></table></div></article>
    </section>}
  </main>;
}

function StatementPanel({ title, leftTitle, left, rightTitle, right, leftTotal, rightTotal, footerLabel, footerValue }: { title: string; leftTitle: string; left: StatementAccount[]; rightTitle: string; right: StatementAccount[]; leftTotal: number; rightTotal: number; footerLabel: string; footerValue: number }) {
  return <article className="controlCard foStatement"><header className="foPanelHeader"><div><p className="eyebrow">Ledger statement</p><h2>{title}</h2></div></header><div className="foStatementColumns"><div><h3>{leftTitle}</h3>{left.map((row) => <div key={row.code}><span>{row.code} · {row.name}</span><b>{money(title.startsWith("Balance") ? row.endingBalance : row.periodBalance, 2)}</b></div>)}<footer><strong>Total {leftTitle.toLowerCase()}</strong><b>{money(leftTotal, 2)}</b></footer></div><div><h3>{rightTitle}</h3>{right.map((row) => <div key={`${row.code}-${row.name}`}><span>{row.code} · {row.name}</span><b>{money(title.startsWith("Balance") ? row.endingBalance : row.periodBalance, 2)}</b></div>)}<footer><strong>Total {rightTitle.toLowerCase()}</strong><b>{money(rightTotal, 2)}</b></footer></div></div><div className="foStatementFooter"><strong>{footerLabel}</strong><b className={classForAmount(footerValue)}>{money(footerValue, 2)}</b></div></article>;
}
