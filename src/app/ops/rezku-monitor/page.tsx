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
type ImportResult = { fileName?: string; reportType: string; rowsRead: number; imported: number };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function eastern(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "Processed") return "good";
  if (status === "Processing" || status === "Partial" || status === "Received") return "warn";
  return "bad";
}

function reportLabel(value: string) {
  if (value === "product_voids") return "Product Voids";
  if (value === "transaction_voids") return "Transaction Voids";
  if (value === "shifts") return "Labor / shifts";
  if (value === "orders") return "Orders";
  if (value === "transactions") return "Transactions";
  return value || "Unknown";
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
    const sourceForm = new FormData(formElement);
    const files = sourceForm.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    if (!files.length) {
      setNotice("Choose one or more Rezku Excel workbooks.");
      return;
    }

    const requestedType = files.length === 1 ? String(sourceForm.get("reportType") || "") : "";
    const successes: ImportResult[] = [];
    const failures: string[] = [];
    setBusy(true);
    setNotice(`Importing 1 of ${files.length}: ${files[0].name}`);

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setNotice(`Importing ${index + 1} of ${files.length}: ${file.name}`);
        const upload = new FormData();
        upload.set("action", "rezku-import");
        upload.set("file", file);
        if (requestedType) upload.set("reportType", requestedType);
        try {
          const response = await fetch("/api/operations", { method: "POST", body: upload });
          if (!response.ok) throw new Error(await responseMessage(response));
          successes.push({ ...(await response.json() as ImportResult), fileName: file.name });
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const repair = await fetch("/api/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rezku-repair-times" }),
      });
      if (!repair.ok) failures.push(`Eastern-time repair: ${await responseMessage(repair)}`);

      formElement.reset();
      await load();
      const rowsRead = successes.reduce((total, result) => total + Number(result.rowsRead || 0), 0);
      const imported = successes.reduce((total, result) => total + Number(result.imported || 0), 0);
      const summary = `Processed ${successes.length} of ${files.length} workbooks, read ${rowsRead} rows, and added ${imported} new rows. Existing Rezku timestamps were checked as Eastern Time.`;
      setNotice(failures.length ? `${summary} Failed: ${failures.join(" | ")}` : summary);
    } finally {
      setBusy(false);
    }
  }

  const latest = data?.emails[0] || null;
  const latestShiftBatch = useMemo(() => data?.imports.find((batch) => batch.reportType === "shifts") || null, [data]);
  const latestVoidBatch = useMemo(() => data?.imports.find((batch) => batch.reportType === "product_voids" || batch.reportType === "transaction_voids") || null, [data]);
  const recentExceptions = data?.punchExceptions.slice(0, 60) || [];

  return <main className="controlPage rezkuMonitorPage">
    <header className="controlHeader">
      <div><p className="eyebrow">Rezku chain of custody · Eastern Time</p><h1>Rezku delivery monitor</h1><p>See whether the daily email reached Corner Ops, which workbooks were processed, how many rows survived import, which punches are incomplete, and whether void reports arrived even when they contained zero rows. Every timestamp on this page is shown in America/New_York time.</p></div>
      <div className="controlActions"><button disabled={busy} onClick={() => void load()}>Refresh</button><a href="/ops/payroll-control">Payroll Control</a><a href="/ops/reports/voids">Void Report</a></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}
    {!latest && <div className="rezkuWarning"><strong>No inbound Rezku email has been recorded.</strong><span>This means the deployed Resend webhook has not delivered one to this database. A copy existing in Gmail does not prove Corner Ops processed it, because apparently email delivery needed its own forensic discipline.</span></div>}

    <section className="metricGrid">
      <div className="metric"><span>Latest email</span><strong>{latest?.reportDate || "Not recorded"}</strong><small>{latest ? eastern(latest.receivedAt) : "No webhook receipt"}</small></div>
      <div className="metric"><span>Email status</span><strong>{latest?.status || "Missing"}</strong><small>{latest ? `${latest.reportsProcessed} of ${latest.reportsFound} reports` : "Deploy and configure inbound mail"}</small></div>
      <div className="metric"><span>Latest labor rows</span><strong>{latestShiftBatch?.rowsImported ?? 0}</strong><small>{latestShiftBatch ? `${latestShiftBatch.rowsRead} read · ${latestShiftBatch.duplicateOrSkipped} duplicate/skipped` : "No labor batch"}</small></div>
      <div className="metric"><span>Latest void rows</span><strong>{latestVoidBatch?.rowsImported ?? 0}</strong><small>{latestVoidBatch ? `${reportLabel(latestVoidBatch.reportType)} · ${latestVoidBatch.rowsRead} read` : "No void batch"}</small></div>
      <div className="metric"><span>Punch exceptions</span><strong>{recentExceptions.length}</strong><small>Missing clock-in or clock-out</small></div>
    </section>

    <div className="rezkuMonitorGrid">
      <section className="controlCard">
        <div><p className="eyebrow">Inbound email</p><h2>Delivery receipts</h2></div>
        <div className="rezkuEmailList">{(data?.emails || []).map((email) => <article key={email.emailId} className="rezkuEmailCard">
          <header><div><strong>{email.reportDate || "Date not parsed"}</strong><span>{eastern(email.receivedAt)}</span></div><span className={`badge ${statusClass(email.status)}`}>{email.status}</span></header>
          <p>{email.reportsProcessed} of {email.reportsFound} workbook{email.reportsFound === 1 ? "" : "s"} processed.</p>
          {email.error && <pre>{email.error}</pre>}
          <div className="rezkuReportRows">{email.reports.map((report) => <div key={report.id}><span><strong>{report.fileName}</strong><small>{reportLabel(report.reportType)} · {report.rowsRead} read · {report.rowsImported} new</small></span><span className={`badge ${statusClass(report.status)}`}>{report.status}</span>{report.error && <small className="rezkuError">{report.error}</small>}</div>)}</div>
        </article>)}{!data?.emails.length && <p>No webhook delivery receipts yet.</p>}</div>
      </section>

      <section className="controlCard">
        <div><p className="eyebrow">Fallback</p><h2>Bulk manual workbook recovery</h2><p>Select every Excel workbook from the Rezku email at once. Corner Ops processes them sequentially, detects each report from its filename, removes Cover rows, maps Can to Ken, and repairs timestamps to Eastern Time.</p></div>
        <form className="controlForm" onSubmit={manualImport}>
          <label>Report type override<select name="reportType"><option value="">Detect each file from filename</option><option value="shifts">Detailed Labor / Shift Attestation</option><option value="orders">Order Export</option><option value="transactions">Transaction Export</option><option value="product_voids">Product Voids</option><option value="transaction_voids">Transaction Voids</option></select><small>The override is used only when one workbook is selected.</small></label>
          <label>Excel workbooks<input name="files" type="file" accept=".xlsx,.xls" multiple required /></label>
          <button className="primary" disabled={busy}>{busy ? "Importing workbooks…" : "Import all selected workbooks"}</button>
        </form>
        <div className="rezkuBatchList">{(data?.imports || []).slice(0, 20).map((batch) => <div key={batch.id}><span><strong>{batch.fileName}</strong><small>{reportLabel(batch.reportType)} · {eastern(batch.importedAt)} · {batch.importedBy}</small></span><span><b>{batch.rowsImported}/{batch.rowsRead}</b><small>{batch.reportType === "shifts" ? `Missing in ${batch.missingClockIn} · missing out ${batch.missingClockOut}` : `${batch.duplicateOrSkipped} duplicate/skipped`}</small></span></div>)}</div>
      </section>
    </div>

    <section className="controlCard">
      <div><p className="eyebrow">Punch evidence</p><h2>Rows received with missing punches</h2><p>Rezku role names are shown exactly as imported. These rows reached the database but cannot become complete payroll punches until the missing side is corrected.</p></div>
      <div className="tableWrap"><table className="controlTable"><thead><tr><th>Employee</th><th>Rezku role</th><th>Clock in</th><th>Clock out</th><th>Reported hours</th><th>Source</th></tr></thead><tbody>{recentExceptions.map((row) => <tr key={row.id}><td><strong>{row.employeeName}</strong></td><td>{row.position || row.roleGroup || "Unspecified"}</td><td className={!row.clockIn ? "missingValue" : ""}>{row.clockIn ? eastern(row.clockIn) : "Missing"}</td><td className={!row.clockOut ? "missingValue" : ""}>{row.clockOut ? eastern(row.clockOut) : "Missing"}</td><td>{row.reportedHours.toFixed(2)}</td><td>{row.fileName}<small>{row.sheet ? `Sheet: ${row.sheet}` : ""}</small></td></tr>)}{recentExceptions.length === 0 && <tr><td colSpan={6}>No imported punch exceptions are currently recorded.</td></tr>}</tbody></table></div>
    </section>
  </main>;
}
