"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import "../control-center.css";
import "./rezku-monitor.css";

type Report = {
  id: string;
  fileName: string;
  reportType: string;
  status: string;
  batchId: string | null;
  rowsRead: number;
  rowsImported: number;
  error: string;
  processedAt: string;
};
type EmailReceipt = {
  emailId: string;
  sender: string;
  subject: string;
  reportDate: string | null;
  receivedAt: string;
  status: string;
  reportsFound: number;
  reportsProcessed: number;
  error: string;
  reports: Report[];
};
type ImportBatch = {
  id: string;
  reportType: string;
  fileName: string;
  rowsRead: number;
  rowsImported: number;
  duplicateOrSkipped: number;
  missingClockIn: number;
  missingClockOut: number;
  importedBy: string;
  importedAt: string;
};
type PunchException = {
  id: string;
  employeeName: string;
  position: string;
  roleGroup: string;
  clockIn: string | null;
  clockOut: string | null;
  reportedHours: number;
  sheet: string;
  fileName: string;
  importedAt: string;
};
type Dashboard = { emails: EmailReceipt[]; imports: ImportBatch[]; punchExceptions: PunchException[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function local(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusClass(status: string) {
  if (status === "Processed") return "good";
  if (status === "Processing" || status === "Partial" || status === "Received") return "warn";
  return "bad";
}

export default function RezkuMonitorPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/rezku-monitor", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Dashboard);
  }

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => void load().catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function manualImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("action", "rezku-import");
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/operations", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { reportType: string; rowsRead: number; imported: number };
      formElement.reset();
      await load();
      setNotice(`${result.reportType} report read ${result.rowsRead} rows and added ${result.imported} new rows.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rezku report could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  const latest = data?.emails[0] || null;
  const latestShiftBatch = useMemo(() => data?.imports.find((batch) => batch.reportType === "shifts") || null, [data]);
  const recentExceptions = data?.punchExceptions.slice(0, 60) || [];

  return <main className="controlPage rezkuMonitorPage">
    <header className="controlHeader">
      <div><p className="eyebrow">Rezku chain of custody</p><h1>Rezku delivery monitor</h1><p>See whether the daily email reached Corner Ops, which workbooks were processed, how many rows survived import, and which punches are incomplete.</p></div>
      <div className="controlActions"><button disabled={busy} onClick={() => void load()}>Refresh</button><a href="/ops/payroll-control">Payroll Control</a></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}
    {!latest && <div className="rezkuWarning"><strong>No inbound Rezku email has been recorded.</strong><span>This means the deployed Resend webhook has not delivered one to this database. A copy existing in Gmail does not prove Corner Ops processed it, because apparently email delivery needed its own forensic discipline.</span></div>}

    <section className="metricGrid">
      <div className="metric"><span>Latest email</span><strong>{latest?.reportDate || "Not recorded"}</strong><small>{latest ? local(latest.receivedAt) : "No webhook receipt"}</small></div>
      <div className="metric"><span>Email status</span><strong>{latest?.status || "Missing"}</strong><small>{latest ? `${latest.reportsProcessed} of ${latest.reportsFound} reports` : "Deploy and configure inbound mail"}</small></div>
      <div className="metric"><span>Latest labor rows</span><strong>{latestShiftBatch?.rowsImported ?? 0}</strong><small>{latestShiftBatch ? `${latestShiftBatch.rowsRead} read · ${latestShiftBatch.duplicateOrSkipped} duplicate/skipped` : "No labor batch"}</small></div>
      <div className="metric"><span>Punch exceptions</span><strong>{recentExceptions.length}</strong><small>Missing clock-in or clock-out</small></div>
    </section>

    <div className="rezkuMonitorGrid">
      <section className="controlCard">
        <div><p className="eyebrow">Inbound email</p><h2>Delivery receipts</h2></div>
        <div className="rezkuEmailList">{(data?.emails || []).map((email) => <article key={email.emailId} className="rezkuEmailCard">
          <header><div><strong>{email.reportDate || "Date not parsed"}</strong><span>{local(email.receivedAt)}</span></div><span className={`badge ${statusClass(email.status)}`}>{email.status}</span></header>
          <p>{email.reportsProcessed} of {email.reportsFound} workbook{email.reportsFound === 1 ? "" : "s"} processed.</p>
          {email.error && <pre>{email.error}</pre>}
          <div className="rezkuReportRows">{email.reports.map((report) => <div key={report.id}><span><strong>{report.fileName}</strong><small>{report.reportType || "unknown"} · {report.rowsRead} read · {report.rowsImported} new</small></span><span className={`badge ${statusClass(report.status)}`}>{report.status}</span>{report.error && <small className="rezkuError">{report.error}</small>}</div>)}</div>
        </article>)}{!data?.emails.length && <p>No webhook delivery receipts yet.</p>}</div>
      </section>

      <section className="controlCard">
        <div><p className="eyebrow">Fallback</p><h2>Manual workbook import</h2><p>Use this for an email received while the newer deployment was offline.</p></div>
        <form className="controlForm" onSubmit={manualImport}>
          <label>Report type<select name="reportType"><option value="">Detect from filename</option><option value="shifts">Detailed Labor / Shift Attestation</option><option value="orders">Order Export</option><option value="transactions">Transaction Export</option></select></label>
          <label>Excel workbook<input name="file" type="file" accept=".xlsx,.xls" required /></label>
          <button className="primary" disabled={busy}>Import workbook</button>
        </form>
        <div className="rezkuBatchList">{(data?.imports || []).slice(0, 20).map((batch) => <div key={batch.id}><span><strong>{batch.fileName}</strong><small>{local(batch.importedAt)} · {batch.importedBy}</small></span><span><b>{batch.rowsImported}/{batch.rowsRead}</b><small>{batch.reportType === "shifts" ? `Missing in ${batch.missingClockIn} · missing out ${batch.missingClockOut}` : `${batch.duplicateOrSkipped} duplicate/skipped`}</small></span></div>)}</div>
      </section>
    </div>

    <section className="controlCard">
      <div><p className="eyebrow">Punch evidence</p><h2>Rows received with missing punches</h2><p>Rezku role names are shown exactly as imported. These rows reached the database but cannot become complete payroll punches until the missing side is corrected.</p></div>
      <div className="tableWrap"><table className="controlTable"><thead><tr><th>Employee</th><th>Rezku role</th><th>Clock in</th><th>Clock out</th><th>Reported hours</th><th>Source</th></tr></thead><tbody>{recentExceptions.map((row) => <tr key={row.id}><td><strong>{row.employeeName}</strong></td><td>{row.position || row.roleGroup || "Unspecified"}</td><td className={!row.clockIn ? "missingValue" : ""}>{row.clockIn ? local(row.clockIn) : "Missing"}</td><td className={!row.clockOut ? "missingValue" : ""}>{row.clockOut ? local(row.clockOut) : "Missing"}</td><td>{row.reportedHours.toFixed(2)}</td><td>{row.fileName}<small>{row.sheet ? `Sheet: ${row.sheet}` : ""}</small></td></tr>)}{recentExceptions.length === 0 && <tr><td colSpan={6}>No imported punch exceptions are currently recorded.</td></tr>}</tbody></table></div>
    </section>
  </main>;
}
