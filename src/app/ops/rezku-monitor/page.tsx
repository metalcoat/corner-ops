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
type RetryResult = { processed?: boolean; reports?: Array<Record<string, unknown>>; failures?: string[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function eastern(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function dateLabel(value: string | null) {
  if (!value) return "Date not parsed";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(date);
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
  return value || "Unknown report";
}

function errorSummary(value: string, max = 260) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export default function RezkuMonitorPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryingEmailId, setRetryingEmailId] = useState("");

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

  async function retryEmail(email: EmailReceipt) {
    setRetryingEmailId(email.emailId);
    setNotice(`Retrying the Rezku reports for ${dateLabel(email.reportDate)}…`);
    try {
      const response = await fetch("/api/rezku-monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-email", emailId: email.emailId }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as RetryResult;
      await load();
      const reportCount = result.reports?.length || 0;
      const failures = result.failures?.length || 0;
      setNotice(failures
        ? `Retry completed with ${reportCount} successful workbook${reportCount === 1 ? "" : "s"} and ${failures} failure${failures === 1 ? "" : "s"}. Open the latest delivery for the exact CDN response.`
        : `Retry completed successfully. ${reportCount} workbook${reportCount === 1 ? "" : "s"} processed.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The Rezku email retry failed.");
    } finally {
      setRetryingEmailId("");
    }
  }

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
      const summary = `Processed ${successes.length} of ${files.length} workbooks, read ${rowsRead} rows, and added ${imported} new rows.`;
      setNotice(failures.length ? `${summary} Failed: ${failures.join(" | ")}` : summary);
    } finally {
      setBusy(false);
    }
  }

  const latest = data?.emails[0] || null;
  const latestShiftBatch = useMemo(() => data?.imports.find((batch) => batch.reportType === "shifts") || null, [data]);
  const recentExceptions = data?.punchExceptions.slice(0, 60) || [];
  const recentImports = data?.imports.slice(0, 20) || [];
  const recentEmails = data?.emails.slice(1, 12) || [];
  const latestFailedReports = latest?.reports.filter((report) => report.status === "Failed").length || 0;
  const automationHealthy = latest?.status === "Processed";

  return <main className="controlPage rezkuMonitorPage">
    <header className="controlHeader rezkuHeader">
      <div>
        <p className="eyebrow">Rezku automation · America/New_York</p>
        <h1>Rezku delivery monitor</h1>
        <p>Track the daily email, workbook downloads, imported rows, and punches requiring correction. Times shown here are Eastern.</p>
      </div>
      <div className="controlActions">
        <button disabled={busy || Boolean(retryingEmailId)} onClick={() => void load()}>Refresh</button>
        <a href="/ops/payroll-control">Payroll Control</a>
        <a href="/ops/reports/voids">Void Report</a>
      </div>
    </header>

    {notice && <div className="noticeBar rezkuNotice">{notice}</div>}

    <section className={`rezkuHealth ${automationHealthy ? "healthy" : latest ? "attention" : "missing"}`}>
      <div className="rezkuHealthMain">
        <div className="rezkuHealthTitle">
          <span className={`badge ${latest ? statusClass(latest.status) : "bad"}`}>{latest?.status || "No email"}</span>
          <div>
            <p className="eyebrow">Automation health</p>
            <h2>{latest ? `${dateLabel(latest.reportDate)} Rezku reports` : "No inbound Rezku delivery recorded"}</h2>
          </div>
        </div>
        <p>{latest
          ? automationHealthy
            ? "The latest email arrived and every detected workbook was processed."
            : `${latest.reportsProcessed} of ${latest.reportsFound} workbooks processed. ${latestFailedReports} report${latestFailedReports === 1 ? "" : "s"} need attention.`
          : "Corner Ops has not recorded an inbound Rezku email in this database."}</p>
        {latest?.error && <div className="rezkuHealthError">{errorSummary(latest.error)}</div>}
        {latest && latest.status !== "Processed" && <button className="primary" disabled={Boolean(retryingEmailId)} onClick={() => void retryEmail(latest)}>
          {retryingEmailId === latest.emailId ? "Retrying email…" : "Retry latest failed email"}
        </button>}
      </div>
      <div className="rezkuHealthStats">
        <article><span>Received</span><strong>{eastern(latest?.receivedAt)}</strong></article>
        <article><span>Workbooks</span><strong>{latest ? `${latest.reportsProcessed}/${latest.reportsFound}` : "0/0"}</strong></article>
        <article><span>Latest labor rows</span><strong>{latestShiftBatch?.rowsImported ?? 0}</strong><small>{latestShiftBatch ? `${latestShiftBatch.rowsRead} read` : "No labor batch"}</small></article>
        <article><span>Punch exceptions</span><strong>{recentExceptions.length}</strong><small>Missing clock-in or clock-out</small></article>
      </div>
    </section>

    <div className="rezkuPrimaryGrid">
      <section className="controlCard rezkuLatestCard">
        <div className="rezkuSectionHeader">
          <div><p className="eyebrow">Latest delivery</p><h2>{latest ? dateLabel(latest.reportDate) : "No email received"}</h2></div>
          {latest && <span className={`badge ${statusClass(latest.status)}`}>{latest.status}</span>}
        </div>
        {latest ? <>
          <div className="rezkuReceiptMeta"><span>Received {eastern(latest.receivedAt)}</span><span>{latest.reportsFound} workbooks detected</span></div>
          <div className="rezkuReportList">{latest.reports.map((report) => <article key={report.id} className={`rezkuReportItem ${report.status.toLowerCase()}`}>
            <div className="rezkuReportIdentity"><strong>{reportLabel(report.reportType)}</strong><small>{report.fileName}</small></div>
            <div className="rezkuReportNumbers"><strong>{report.rowsImported}</strong><small>new of {report.rowsRead} read</small></div>
            <span className={`badge ${statusClass(report.status)}`}>{report.status}</span>
            {report.error && <div className="rezkuDiagnostic"><strong>Download/import diagnostic</strong><code>{report.error}</code></div>}
          </article>)}</div>
        </> : <p className="rezkuEmpty">No inbound receipt has been stored yet.</p>}
      </section>

      <section className="controlCard rezkuRecoveryCard">
        <div><p className="eyebrow">Manual recovery</p><h2>Import Rezku workbooks</h2><p>Use this only when automated download fails. Select every Excel workbook from one Rezku email at once.</p></div>
        <form className="controlForm rezkuRecoveryForm" onSubmit={manualImport}>
          <label>Report type override<select name="reportType"><option value="">Detect each filename</option><option value="shifts">Detailed Labor / Shift Attestation</option><option value="orders">Order Export</option><option value="transactions">Transaction Export</option><option value="product_voids">Product Voids</option><option value="transaction_voids">Transaction Voids</option></select><small>Used only when one workbook is selected.</small></label>
          <label>Excel workbooks<input name="files" type="file" accept=".xlsx,.xls" multiple required /></label>
          <button className="primary" disabled={busy || Boolean(retryingEmailId)}>{busy ? "Importing workbooks…" : "Import selected workbooks"}</button>
        </form>
        <div className="rezkuRecoveryNotes">
          <span>✓ Detects report type</span><span>✓ Removes Cover rows</span><span>✓ Maps Can to Ken</span><span>✓ Repairs Eastern timestamps</span>
        </div>
      </section>
    </div>

    <section className="controlCard rezkuHistoryCard">
      <div className="rezkuSectionHeader"><div><p className="eyebrow">Recent deliveries</p><h2>Email history</h2></div><span>{recentEmails.length} prior email{recentEmails.length === 1 ? "" : "s"}</span></div>
      <div className="rezkuHistoryList">{recentEmails.map((email) => <details key={email.emailId} className="rezkuHistoryItem">
        <summary>
          <span><strong>{dateLabel(email.reportDate)}</strong><small>{eastern(email.receivedAt)}</small></span>
          <span><b>{email.reportsProcessed}/{email.reportsFound}</b><span className={`badge ${statusClass(email.status)}`}>{email.status}</span></span>
        </summary>
        <div className="rezkuHistoryBody">
          {email.error && <div className="rezkuDiagnostic"><strong>Email diagnostic</strong><code>{email.error}</code></div>}
          <div className="rezkuHistoryReports">{email.reports.map((report) => <div key={report.id}><span><strong>{reportLabel(report.reportType)}</strong><small>{report.fileName}</small></span><span><b>{report.rowsImported}/{report.rowsRead}</b><span className={`badge ${statusClass(report.status)}`}>{report.status}</span></span>{report.error && <code>{report.error}</code>}</div>)}</div>
          {email.status !== "Processed" && <button disabled={Boolean(retryingEmailId)} onClick={() => void retryEmail(email)}>{retryingEmailId === email.emailId ? "Retrying…" : "Retry this email"}</button>}
        </div>
      </details>)}{recentEmails.length === 0 && <p className="rezkuEmpty">No earlier email deliveries are recorded.</p>}</div>
    </section>

    <section className="controlCard">
      <div className="rezkuSectionHeader"><div><p className="eyebrow">Database imports</p><h2>Recent workbook batches</h2></div><span>{recentImports.length} shown</span></div>
      <div className="tableWrap"><table className="controlTable rezkuImportTable">
        <thead><tr><th>Workbook</th><th>Report</th><th>Imported</th><th>Skipped</th><th>Exceptions</th><th>Processed</th></tr></thead>
        <tbody>{recentImports.map((batch) => <tr key={batch.id}>
          <td><strong>{batch.fileName}</strong><small>{batch.importedBy}</small></td>
          <td>{reportLabel(batch.reportType)}</td>
          <td>{batch.rowsImported}/{batch.rowsRead}</td>
          <td>{batch.duplicateOrSkipped}</td>
          <td>{batch.reportType === "shifts" ? `${batch.missingClockIn} missing in · ${batch.missingClockOut} missing out` : "—"}</td>
          <td>{eastern(batch.importedAt)}</td>
        </tr>)}{recentImports.length === 0 && <tr><td colSpan={6}>No workbook batches are recorded.</td></tr>}</tbody>
      </table></div>
    </section>

    <section className="controlCard">
      <div className="rezkuSectionHeader"><div><p className="eyebrow">Payroll attention</p><h2>Incomplete punches</h2><p>These imported rows cannot become complete payroll punches until the missing time is corrected.</p></div><span className={`badge ${recentExceptions.length ? "warn" : "good"}`}>{recentExceptions.length}</span></div>
      <div className="tableWrap"><table className="controlTable rezkuExceptionTable">
        <thead><tr><th>Employee</th><th>Rezku role</th><th>Clock in</th><th>Clock out</th><th>Hours</th><th>Source</th></tr></thead>
        <tbody>{recentExceptions.map((row) => <tr key={row.id}><td><strong>{row.employeeName}</strong></td><td>{row.position || row.roleGroup || "Unspecified"}</td><td className={!row.clockIn ? "missingValue" : ""}>{row.clockIn ? eastern(row.clockIn) : "Missing"}</td><td className={!row.clockOut ? "missingValue" : ""}>{row.clockOut ? eastern(row.clockOut) : "Missing"}</td><td>{row.reportedHours.toFixed(2)}</td><td>{row.fileName}<small>{row.sheet ? `Sheet: ${row.sheet}` : ""}</small></td></tr>)}{recentExceptions.length === 0 && <tr><td colSpan={6}>No incomplete punches are currently recorded.</td></tr>}</tbody>
      </table></div>
    </section>
  </main>;
}
