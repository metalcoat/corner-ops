"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import "../../control-center.css";
import "./voids.css";

type VoidEvent = {
  id: string;
  voidType: "Product" | "Transaction";
  orderId: string;
  transactionId: string;
  voidedAt: string | null;
  timeKnown: boolean;
  employeeName: string;
  voidedBy: string;
  reason: string;
  itemName: string;
  quantity: number;
  amount: number;
  sourceFile: string;
  importedAt: string;
  sheet: string;
};

type VoidDay = {
  date: string;
  productCount: number;
  productAmount: number;
  transactionCount: number;
  transactionAmount: number;
};

type Payload = {
  business: "Corner Deli";
  range: { start: string; end: string };
  summary: {
    productCount: number;
    productAmount: number;
    transactionCount: number;
    transactionAmount: number;
    missingReasonCount: number;
    missingTimeCount: number;
    totalCount: number;
    totalAmount: number;
  };
  daily: VoidDay[];
  recent: VoidEvent[];
  topItems: Array<{ item: string; voidCount: number; quantity: number; amount: number }>;
  byVoider: Array<{ employee: string; voidCount: number; amount: number }>;
  coverage: { firstRecord: string | null; lastRecord: string | null; records: number };
  imports: Array<{ id: string; reportType: string; fileName: string; rowsRead: number; rowsImported: number; importedBy: string; importedAt: string }>;
};

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value || 0);

function todayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateLabel(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" });
}

function local(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function reportLabel(value: string) {
  return value === "product_voids" ? "Product Voids" : value === "transaction_voids" ? "Transaction Voids" : value;
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function VoidReportPage() {
  const today = useMemo(todayKey, []);
  const [start, setStart] = useState(() => addDays(today, -29));
  const [end, setEnd] = useState(() => addDays(today, 1));
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!start || !end || end <= start) return;
    const controller = new AbortController();
    setBusy(true);
    setNotice("");
    const query = new URLSearchParams({ start, end });
    fetch(`/api/reports/voids?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<Payload>;
      })
      .then(setData)
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [end, nonce, start]);

  async function manualImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/reports/voids", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { reportType: string; rowsRead: number; imported: number };
      formElement.reset();
      setNonce((value) => value + 1);
      setNotice(`${reportLabel(result.reportType)} read ${result.rowsRead} rows and added ${result.imported} new void record${result.imported === 1 ? "" : "s"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Void report could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  const summary = data?.summary;
  const latest = data?.recent[0] || null;
  const topItem = data?.topItems[0] || null;
  const topVoider = data?.byVoider[0] || null;
  const maxDaily = Math.max(1, ...(data?.daily || []).map((day) => day.productAmount + day.transactionAmount));

  return <main className={`controlPage voidReportPage ${busy ? "voidReportLoading" : ""}`}>
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Loss prevention and corrections</p>
        <h1>Corner Deli voids and reversals</h1>
        <p>Track what was voided, when it happened, who performed it, why it happened, and whether Rezku removed one product or the entire transaction.</p>
      </div>
      <div className="controlActions"><button disabled={busy} onClick={() => setNonce((value) => value + 1)}>Refresh</button><a href="/ops/rezku-monitor">Rezku Monitor</a></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <section className="controlCard voidFilters">
      <div className="voidPresetRow">
        <button onClick={() => { setStart(addDays(today, -6)); setEnd(addDays(today, 1)); }}>7 days</button>
        <button onClick={() => { setStart(addDays(today, -29)); setEnd(addDays(today, 1)); }}>30 days</button>
        <button onClick={() => { setStart(addDays(today, -89)); setEnd(addDays(today, 1)); }}>90 days</button>
        <button onClick={() => { setStart(`${today.slice(0, 4)}-01-01`); setEnd(addDays(today, 1)); }}>Year to date</button>
      </div>
      <label>Start<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>End, exclusive<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
    </section>

    <section className="metricGrid voidMetricGrid">
      <div className="metric"><span>Total void records</span><strong>{summary?.totalCount || 0}</strong><small>{money(summary?.totalAmount || 0)} reported value</small></div>
      <div className="metric"><span>Product voids</span><strong>{summary?.productCount || 0}</strong><small>{money(summary?.productAmount || 0)}</small></div>
      <div className="metric"><span>Transaction voids</span><strong>{summary?.transactionCount || 0}</strong><small>{money(summary?.transactionAmount || 0)}</small></div>
      <div className="metric"><span>Missing reasons</span><strong>{summary?.missingReasonCount || 0}</strong><small>{summary?.missingTimeCount || 0} also missing source time</small></div>
    </section>

    <section className="voidIntelligenceGrid">
      <article className="controlCard voidInsight"><p className="eyebrow">Latest activity</p><h2>{latest ? (latest.timeKnown && latest.voidedAt ? local(latest.voidedAt) : `Imported ${local(latest.importedAt)}`) : "No voids in range"}</h2><p>{latest ? `${latest.voidType} void · ${latest.itemName || latest.orderId || latest.transactionId || "unidentified record"}` : "A zero-row report remains visible in the import history below."}</p></article>
      <article className="controlCard voidInsight"><p className="eyebrow">Most voided product</p><h2>{topItem?.item || "No product voids"}</h2><p>{topItem ? `${topItem.voidCount} voids · ${number(topItem.quantity)} units · ${money(topItem.amount)}` : "The product report has not supplied a populated row in this range."}</p></article>
      <article className="controlCard voidInsight"><p className="eyebrow">Most activity by</p><h2>{topVoider?.employee || "No employee identified"}</h2><p>{topVoider ? `${topVoider.voidCount} voids · ${money(topVoider.amount)}` : "Rezku has not supplied an employee or approving manager yet."}</p></article>
    </section>

    <section className="controlCard">
      <div className="sectionHeading"><div><p className="eyebrow">Daily pattern</p><h2>Reported void value by business day</h2></div><span>Business day runs 4 AM to 4 AM Eastern</span></div>
      <div className="voidDailyChart">{(data?.daily || []).map((day) => {
        const productHeight = Math.max(day.productAmount ? 3 : 0, (day.productAmount / maxDaily) * 100);
        const transactionHeight = Math.max(day.transactionAmount ? 3 : 0, (day.transactionAmount / maxDaily) * 100);
        return <article key={day.date} title={`${dateLabel(day.date)} · Product ${money(day.productAmount)} · Transaction ${money(day.transactionAmount)}`}>
          <div className="voidBars"><i className="product" style={{ height: `${productHeight}%` }} /><i className="transaction" style={{ height: `${transactionHeight}%` }} /></div>
          <strong>{day.productCount + day.transactionCount}</strong><small>{dateLabel(day.date)}</small>
        </article>;
      })}{!data?.daily.length && <p>No populated void rows exist in the selected range.</p>}</div>
      <div className="voidLegend"><span><i className="product" />Product voids</span><span><i className="transaction" />Transaction voids</span></div>
    </section>

    <section className="controlCard">
      <div className="sectionHeading"><div><p className="eyebrow">Audit timeline</p><h2>Individual void records</h2></div><span>{data?.recent.length || 0} shown</span></div>
      <div className="tableWrap"><table className="controlTable voidTable"><thead><tr><th>When</th><th>Type</th><th>Order / transaction</th><th>Product</th><th>Qty</th><th>Amount</th><th>Employee</th><th>Voided by</th><th>Reason</th><th>Source</th></tr></thead><tbody>{(data?.recent || []).map((row) => <tr key={row.id}><td className={!row.timeKnown ? "missingValue" : ""}>{row.voidedAt ? local(row.voidedAt) : `Unknown · imported ${local(row.importedAt)}`}</td><td><span className={`voidType ${row.voidType.toLowerCase()}`}>{row.voidType}</span></td><td>{row.orderId || row.transactionId || "Not supplied"}<small>{row.orderId && row.transactionId ? row.transactionId : ""}</small></td><td>{row.itemName || (row.voidType === "Transaction" ? "Entire transaction" : "Not supplied")}</td><td>{row.quantity ? number(row.quantity) : "—"}</td><td>{money(row.amount)}</td><td>{row.employeeName || "Not supplied"}</td><td>{row.voidedBy || "Not supplied"}</td><td className={!row.reason ? "missingValue" : ""}>{row.reason || "No reason supplied"}</td><td>{row.sourceFile}<small>{row.sheet ? `Sheet: ${row.sheet}` : ""}</small></td></tr>)}{!data?.recent.length && <tr><td colSpan={10}>No populated void records exist for this period. Check the import receipts below to confirm whether zero-row reports were received.</td></tr>}</tbody></table></div>
    </section>

    <div className="voidBottomGrid">
      <section className="controlCard"><div><p className="eyebrow">Products</p><h2>Top voided products</h2></div><div className="voidRankList">{(data?.topItems || []).map((item) => <div key={item.item}><span><strong>{item.item}</strong><small>{number(item.quantity)} units · {item.voidCount} records</small></span><b>{money(item.amount)}</b></div>)}{!data?.topItems.length && <p>No product void details are available.</p>}</div></section>
      <section className="controlCard"><div><p className="eyebrow">Employees and managers</p><h2>Void activity by person</h2></div><div className="voidRankList">{(data?.byVoider || []).map((item) => <div key={item.employee}><span><strong>{item.employee}</strong><small>{item.voidCount} records</small></span><b>{money(item.amount)}</b></div>)}{!data?.byVoider.length && <p>No employee identifiers are available.</p>}</div></section>
    </div>

    <section className="controlCard">
      <details className="voidImportDetails"><summary>Report receipts and manual import</summary><div className="voidImportGrid">
        <form className="controlForm" onSubmit={manualImport}>
          <label>Report type<select name="reportType" defaultValue=""><option value="">Detect from filename</option><option value="product_voids">Product Voids</option><option value="transaction_voids">Transaction Voids</option></select></label>
          <label>Excel workbook<input name="file" type="file" accept=".xlsx,.xls" required /></label>
          <button className="primary" disabled={busy}>Import void workbook</button>
        </form>
        <div className="voidImportList">{(data?.imports || []).map((item) => <div key={item.id}><span><strong>{item.fileName}</strong><small>{reportLabel(item.reportType)} · {local(item.importedAt)} · {item.importedBy}</small></span><b>{item.rowsImported}/{item.rowsRead}</b></div>)}{!data?.imports.length && <p>No void workbooks have been recorded yet.</p>}</div>
      </div></details>
    </section>
  </main>;
}
