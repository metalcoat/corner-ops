"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { businesses, type Business, type SessionView } from "@/lib/types";

type Tab = "overview" | "time" | "payroll" | "accounting";
type Employee = {
  id: string;
  business: Business;
  name: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  countsForTips: boolean;
  hourlyRate: number;
  tippedRate: number;
  active: boolean;
};
type TimeEntry = {
  id: string;
  employeeName: string;
  position: string;
  clockIn: string;
  clockOut: string | null;
  source: string;
  status: string;
  clockInLocation: {
    latitude: number | null;
    longitude: number | null;
    accuracy: number | null;
  };
};
type PayrollRow = {
  employee: string;
  hours: number;
  regularHours: number;
  overtimeHours: number;
  driverTipHours: number;
  tips: number;
  pickupTips: number;
  deliveryTips: number;
};
type PayrollPayload = {
  source: string;
  weekStart: string;
  weekEnd: string;
  rows: PayrollRow[];
  tipDetails: Array<{
    time: string;
    orderId: string;
    orderType: string;
    originalTip: number;
    tipAfterFee: number;
    employee: string;
    splitCount: number;
    rule: string;
  }>;
};
type ImportBatch = {
  id: string;
  reportType: string;
  fileName: string;
  rowCount: number;
  importedBy: string;
  importedAt: string;
};
type Account = {
  id: string;
  code: string;
  name: string;
  accountType: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense";
};
type AccountingPayload = {
  summary: {
    revenue: number;
    expenses: number;
    profit: number;
    assets: number;
    liabilities: number;
    equity: number;
  };
  accounts: Account[];
  recent: Array<{
    id: string;
    entryDate: string;
    description: string;
    source: string;
    reference: string;
    amount: number;
  }>;
};

async function messageFrom(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function hours(value: number): string {
  return Number(value || 0).toFixed(2);
}

function previousMonday(): string {
  const date = new Date();
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday - 7);
  return date.toISOString().slice(0, 10);
}

export default function OperationsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [tab, setTab] = useState<Tab>("overview");
  const [weekStart, setWeekStart] = useState(previousMonday());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [payroll, setPayroll] = useState<PayrollPayload | null>(null);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [accounting, setAccounting] = useState<AccountingPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() =>
        setSession({
          authenticated: false,
          configured: false,
          missing: ["Unable to reach server"],
        }),
      );
  }, []);

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(await messageFrom(response));
    return response.json() as Promise<T>;
  }

  async function loadTime(): Promise<void> {
    const [employeePayload, timePayload] = await Promise.all([
      getJson<{ employees: Employee[] }>("/api/operations?area=employees&business=Tiki"),
      getJson<{ entries: TimeEntry[] }>("/api/operations?area=time&business=Tiki"),
    ]);
    setEmployees(employeePayload.employees);
    setEntries(timePayload.entries);
  }

  async function loadPayroll(activeBusiness = business): Promise<void> {
    const payrollPayload = await getJson<PayrollPayload>(
      `/api/operations?area=payroll&business=${encodeURIComponent(activeBusiness)}&weekStart=${weekStart}`,
    );
    setPayroll(payrollPayload);

    if (activeBusiness === "Corner Deli") {
      const importPayload = await getJson<{ imports: ImportBatch[] }>(
        "/api/operations?area=imports&business=Corner%20Deli",
      );
      setImports(importPayload.imports);
    }
  }

  async function loadAccounting(activeBusiness = business): Promise<void> {
    setAccounting(
      await getJson<AccountingPayload>(
        `/api/operations?area=accounting&business=${encodeURIComponent(activeBusiness)}`,
      ),
    );
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    void Promise.all([loadTime(), loadPayroll(business), loadAccounting(business)]).catch(
      (error) => setNotice(error instanceof Error ? error.message : String(error)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated]);

  useEffect(() => {
    if (!session?.authenticated) return;
    void Promise.all([loadPayroll(business), loadAccounting(business)]).catch(
      (error) => setNotice(error instanceof Error ? error.message : String(error)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, weekStart]);

  async function postJson(body: Record<string, unknown>) {
    const response = await fetch("/api/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await messageFrom(response));
    return response.json();
  }

  function selectBusiness(nextBusiness: Business): void {
    setBusiness(nextBusiness);
    setNotice("");
    if (nextBusiness === "Corner Deli" && tab === "time") setTab("overview");
  }

  async function createEmployee(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      await postJson({
        action: "employee-create",
        business: "Tiki",
        name: form.get("name"),
        pin: form.get("pin"),
        position: form.get("position"),
        roleGroup: form.get("roleGroup"),
        countsForTips: form.get("countsForTips") === "on",
        hourlyRate: form.get("hourlyRate"),
        tippedRate: form.get("tippedRate"),
      });
      event.currentTarget.reset();
      await loadTime();
      setNotice("Tiki employee created. Their five-digit PIN is ready.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Employee could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEmployee(employee: Employee): Promise<void> {
    setBusy(true);
    try {
      await postJson({
        action: "employee-update",
        id: employee.id,
        active: !employee.active,
      });
      await loadTime();
      setNotice(`${employee.name} is now ${employee.active ? "inactive" : "active"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Employee could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function importRezku(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    form.set("action", "rezku-import");
    try {
      const response = await fetch("/api/operations", {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const result = (await response.json()) as {
        reportType: string;
        rowsRead: number;
        imported: number;
      };
      event.currentTarget.reset();
      await loadPayroll("Corner Deli");
      setNotice(
        `Rezku ${result.reportType} processed: ${result.imported} new rows from ${result.rowsRead} read.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rezku report could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  async function createJournal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      await postJson({
        action: "journal-create",
        business,
        entryDate: form.get("entryDate"),
        description: form.get("description"),
        reference: form.get("reference"),
        kind: form.get("kind"),
        accountCode: form.get("accountCode"),
        amount: form.get("amount"),
      });
      event.currentTarget.reset();
      await loadAccounting(business);
      setNotice(`${business} accounting entry posted.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Accounting entry could not be posted.");
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    await fetch("/api/auth/session", { method: "DELETE" });
    window.location.href = "/";
  }

  const openPunches = entries.filter((entry) => !entry.clockOut);
  const payrollTotals = useMemo(
    () =>
      payroll?.rows.reduce(
        (totals, row) => ({
          hours: totals.hours + Number(row.hours || 0),
          overtime: totals.overtime + Number(row.overtimeHours || 0),
          tips: totals.tips + Number(row.tips || 0),
        }),
        { hours: 0, overtime: 0, tips: 0 },
      ) || { hours: 0, overtime: 0, tips: 0 },
    [payroll],
  );

  if (!session) {
    return (
      <main className="centered">
        <div className="loginCard">
          <h1>Loading Corner Ops</h1>
        </div>
      </main>
    );
  }

  if (!session.authenticated) {
    return (
      <main className="centered">
        <section className="loginCard">
          <p className="eyebrow">Owner access required</p>
          <h1>Sign in first</h1>
          <p className="muted">
            The operating system uses the same owner password as the document vault.
          </p>
          <a className="primary" href="/">
            Return to sign-in
          </a>
        </section>
      </main>
    );
  }

  const accountingAccounts =
    accounting?.accounts.filter(
      (account) => account.accountType === "Revenue" || account.accountType === "Expense",
    ) || [];

  const pageTitle =
    tab === "overview"
      ? `${business} command center`
      : tab === "time"
        ? "Tiki people and time"
        : tab === "payroll"
          ? `${business} payroll and tips`
          : `${business} accounting ledger`;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Internal operations</p>
          <h1>Corner Ops</h1>
          <p className="sidebarBusiness">{business}</p>
        </div>
        <nav>
          <button
            className={`navItem ${tab === "overview" ? "active" : ""}`}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          {business === "Tiki" && (
            <button
              className={`navItem ${tab === "time" ? "active" : ""}`}
              onClick={() => setTab("time")}
            >
              Time clock
            </button>
          )}
          <button
            className={`navItem ${tab === "payroll" ? "active" : ""}`}
            onClick={() => setTab("payroll")}
          >
            Payroll & tips
          </button>
          <button
            className={`navItem ${tab === "accounting" ? "active" : ""}`}
            onClick={() => setTab("accounting")}
          >
            Accounting
          </button>
          <a className="navItem" href="/">
            Documents
          </a>
          {business === "Tiki" && (
            <a className="navItem" href="/clock">
              Employee clock
            </a>
          )}
        </nav>
        <div className="sidebarFooter">
          <p>{session.email}</p>
          <button className="textButton neutral" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Business operating system</p>
            <h2>{pageTitle}</h2>
          </div>
          <div className="headerActions">
            <div className="businessSwitch" aria-label="Choose business">
              {businesses.map((name) => (
                <button
                  key={name}
                  className={business === name ? "selected" : ""}
                  onClick={() => selectBusiness(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            {business === "Tiki" && (
              <a className="secondary" href="/clock">
                Tiki clock link
              </a>
            )}
          </div>
        </header>

        {notice && <div className="notice opsNotice">{notice}</div>}

        {tab === "overview" && (
          <>
            {business === "Corner Deli" ? (
              <section className="stats fourStats">
                <article>
                  <span>Rezku reports imported</span>
                  <strong>{imports.length}</strong>
                </article>
                <article>
                  <span>Payroll hours</span>
                  <strong>{hours(payrollTotals.hours)}</strong>
                </article>
                <article>
                  <span>Tips after fee</span>
                  <strong>{money(payrollTotals.tips)}</strong>
                </article>
                <article>
                  <span>Current profit</span>
                  <strong>{money(accounting?.summary.profit || 0)}</strong>
                </article>
              </section>
            ) : (
              <section className="stats fourStats">
                <article>
                  <span>Active employees</span>
                  <strong>{employees.filter((employee) => employee.active).length}</strong>
                </article>
                <article>
                  <span>Open punches</span>
                  <strong>{openPunches.length}</strong>
                </article>
                <article>
                  <span>Payroll hours</span>
                  <strong>{hours(payrollTotals.hours)}</strong>
                </article>
                <article>
                  <span>Current profit</span>
                  <strong>{money(accounting?.summary.profit || 0)}</strong>
                </article>
              </section>
            )}

            <section className="opsGrid">
              {business === "Tiki" ? (
                <article className="panel moduleCard">
                  <p className="eyebrow">Tiki</p>
                  <h3>PIN time clock</h3>
                  <p>Five-digit employee PINs, GPS capture, rates, roles, and weekly hours.</p>
                  <button className="secondary" onClick={() => setTab("time")}>
                    Manage time
                  </button>
                </article>
              ) : (
                <article className="panel moduleCard">
                  <p className="eyebrow">Corner Deli</p>
                  <h3>Direct Rezku ingestion</h3>
                  <p>
                    Daily Rezku messages arrive through Resend and are processed directly by
                    Vercel.
                  </p>
                  <button className="secondary" onClick={() => setTab("payroll")}>
                    Open payroll
                  </button>
                </article>
              )}

              <article className="panel moduleCard">
                <p className="eyebrow">{business}</p>
                <h3>Payroll and tips</h3>
                <p>
                  {business === "Corner Deli"
                    ? "Rezku labor, orders, and transactions feed the established tip rules."
                    : "Tiki clock records feed weekly hours, overtime, and payroll review."}
                </p>
                <button className="secondary" onClick={() => setTab("payroll")}>
                  Open payroll
                </button>
              </article>

              <article className="panel moduleCard">
                <p className="eyebrow">{business}</p>
                <h3>Accounting ledger</h3>
                <p>Separate double-entry books, income totals, and balance-sheet balances.</p>
                <button className="secondary" onClick={() => setTab("accounting")}>
                  Open accounting
                </button>
              </article>

              <article className="panel moduleCard">
                <p className="eyebrow">{business}</p>
                <h3>Private records</h3>
                <p>The document vault remains available alongside actual operations.</p>
                <a className="secondary" href="/">
                  Open documents
                </a>
              </article>
            </section>
          </>
        )}

        {tab === "time" && business === "Tiki" && (
          <>
            <section className="stats">
              <article>
                <span>Active employees</span>
                <strong>{employees.filter((employee) => employee.active).length}</strong>
              </article>
              <article>
                <span>Currently clocked in</span>
                <strong>{openPunches.length}</strong>
              </article>
              <article>
                <span>Recent punch records</span>
                <strong>{entries.length}</strong>
              </article>
            </section>

            <section className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Tiki only</p>
                  <h3>Add employee</h3>
                </div>
                <a className="secondary" href="/clock">
                  Open kiosk clock
                </a>
              </div>
              <form className="uploadForm opsForm" onSubmit={createEmployee}>
                <label>
                  Name
                  <input name="name" required maxLength={120} />
                </label>
                <label>
                  Five-digit PIN
                  <input
                    name="pin"
                    inputMode="numeric"
                    pattern="\d{5}"
                    maxLength={5}
                    required
                  />
                </label>
                <label>
                  Position
                  <input name="position" defaultValue="Bartender" required />
                </label>
                <label>
                  Role group
                  <select name="roleGroup">
                    <option>In-House</option>
                    <option>Driver</option>
                    <option>Ignore</option>
                  </select>
                </label>
                <label>
                  Regular hourly rate
                  <input name="hourlyRate" type="number" min="0" step="0.01" defaultValue="0" />
                </label>
                <label>
                  Tipped hourly rate
                  <input name="tippedRate" type="number" min="0" step="0.01" defaultValue="0" />
                </label>
                <label className="checkboxLabel">
                  <input name="countsForTips" type="checkbox" defaultChecked />
                  Include in tip pools
                </label>
                <button className="primary" disabled={busy}>
                  Create employee
                </button>
              </form>

              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Position</th>
                      <th>Role</th>
                      <th>Rates</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.id}>
                        <td>
                          <strong>{employee.name}</strong>
                        </td>
                        <td>{employee.position}</td>
                        <td>
                          {employee.roleGroup}
                          {employee.countsForTips ? " · tips" : ""}
                        </td>
                        <td>
                          {money(employee.hourlyRate)} / {money(employee.tippedRate)} tipped
                        </td>
                        <td>
                          <span className={`badge ${employee.active ? "active" : "archived"}`}>
                            {employee.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td>
                          <button
                            className="textButton neutral"
                            disabled={busy}
                            onClick={() => toggleEmployee(employee)}
                          >
                            {employee.active ? "Deactivate" : "Reactivate"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel activityPanel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Punch review</p>
                  <h3>Recent Tiki time entries</h3>
                </div>
              </div>
              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Clock in</th>
                      <th>Clock out</th>
                      <th>Hours</th>
                      <th>Location</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const start = new Date(entry.clockIn);
                      const end = entry.clockOut ? new Date(entry.clockOut) : null;
                      const total = end ? (end.getTime() - start.getTime()) / 3_600_000 : 0;
                      return (
                        <tr key={entry.id}>
                          <td>
                            <strong>{entry.employeeName}</strong>
                            <small>{entry.position}</small>
                          </td>
                          <td>{start.toLocaleString()}</td>
                          <td>{end ? end.toLocaleString() : "Still clocked in"}</td>
                          <td>{end ? hours(total) : "Open"}</td>
                          <td>
                            {entry.clockInLocation.latitude === null
                              ? "Missing"
                              : `${Number(entry.clockInLocation.accuracy || 0).toFixed(0)}m accuracy`}
                          </td>
                          <td>
                            <span
                              className={`badge ${
                                entry.status === "Complete" ? "active" : "needsreview"
                              }`}
                            >
                              {entry.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {tab === "payroll" && (
          <>
            <section className="toolbarPanel">
              <strong>{business}</strong>
              <label>
                Payroll week starting
                <input
                  type="date"
                  value={weekStart}
                  onChange={(event) => setWeekStart(event.target.value)}
                />
              </label>
              <button className="secondary" onClick={() => void loadPayroll(business)}>
                Recalculate
              </button>
            </section>

            <section className="stats">
              <article>
                <span>Total hours</span>
                <strong>{hours(payrollTotals.hours)}</strong>
              </article>
              <article>
                <span>Overtime hours</span>
                <strong>{hours(payrollTotals.overtime)}</strong>
              </article>
              <article>
                <span>Tips after 3.5% fee</span>
                <strong>{money(payrollTotals.tips)}</strong>
              </article>
            </section>

            {business === "Corner Deli" && (
              <section className="panel">
                <div className="panelHeader">
                  <div>
                    <p className="eyebrow">Rezku source</p>
                    <h3>Direct inbound email plus manual fallback</h3>
                  </div>
                  <span className="badge active">Resend → Vercel</span>
                </div>
                <form className="uploadForm opsForm" onSubmit={importRezku}>
                  <label>
                    Report type
                    <select name="reportType">
                      <option value="">Detect from filename</option>
                      <option value="shifts">Detailed Labor / Shifts</option>
                      <option value="orders">Order Export</option>
                      <option value="transactions">Transaction Export</option>
                    </select>
                  </label>
                  <label>
                    Excel report
                    <input name="file" type="file" accept=".xlsx,.xls" required />
                  </label>
                  <button className="primary" disabled={busy}>
                    Import Rezku report
                  </button>
                </form>
                <div className="ruleStrip">
                  <span>3.5% deduction</span>
                  <span>Before 3 PM shared</span>
                  <span>Delivery to drivers</span>
                  <span>35-minute grace</span>
                  <span>Last-out fallback</span>
                </div>
              </section>
            )}

            <section className="panel activityPanel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">{payroll?.source || "Payroll source"}</p>
                  <h3>Employee payroll summary</h3>
                </div>
              </div>
              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Total hours</th>
                      <th>Regular</th>
                      <th>OT</th>
                      <th>Driver tipped hours</th>
                      <th>Pickup tips</th>
                      <th>Delivery tips</th>
                      <th>Total tips</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(payroll?.rows || []).map((row) => (
                      <tr key={row.employee}>
                        <td>
                          <strong>{row.employee}</strong>
                        </td>
                        <td>{hours(row.hours)}</td>
                        <td>{hours(row.regularHours)}</td>
                        <td>{hours(row.overtimeHours)}</td>
                        <td>{hours(row.driverTipHours)}</td>
                        <td>{money(row.pickupTips)}</td>
                        <td>{money(row.deliveryTips)}</td>
                        <td>
                          <strong>{money(row.tips)}</strong>
                        </td>
                      </tr>
                    ))}
                    {payroll?.rows.length === 0 && (
                      <tr>
                        <td colSpan={8}>No payroll records were found for this week.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {business === "Corner Deli" && (
              <section className="opsGrid twoCols">
                <article className="panel">
                  <div className="panelHeader">
                    <div>
                      <p className="eyebrow">Import history</p>
                      <h3>Recent Rezku reports</h3>
                    </div>
                  </div>
                  <div className="compactList">
                    {imports.slice(0, 12).map((batch) => (
                      <div key={batch.id}>
                        <strong>{batch.fileName}</strong>
                        <span>
                          {batch.reportType} · {batch.rowCount} rows ·{" "}
                          {new Date(batch.importedAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                    {imports.length === 0 && (
                      <div className="empty">No Rezku reports imported yet.</div>
                    )}
                  </div>
                </article>

                <article className="panel">
                  <div className="panelHeader">
                    <div>
                      <p className="eyebrow">Audit detail</p>
                      <h3>Recent tip allocations</h3>
                    </div>
                  </div>
                  <div className="compactList">
                    {(payroll?.tipDetails || []).slice(0, 20).map((detail, index) => (
                      <div key={`${detail.orderId}-${detail.employee}-${index}`}>
                        <strong>
                          {detail.employee}: {money(detail.tipAfterFee / detail.splitCount)}
                        </strong>
                        <span>
                          {detail.orderType || "Unknown order"} · {detail.orderId} · {detail.rule}
                        </span>
                      </div>
                    ))}
                    {payroll?.tipDetails.length === 0 && (
                      <div className="empty">No tip allocations found.</div>
                    )}
                  </div>
                </article>
              </section>
            )}
          </>
        )}

        {tab === "accounting" && (
          <>
            <section className="toolbarPanel">
              <strong>{business} books</strong>
            </section>
            <section className="stats fourStats">
              <article>
                <span>Revenue</span>
                <strong>{money(accounting?.summary.revenue || 0)}</strong>
              </article>
              <article>
                <span>Expenses</span>
                <strong>{money(accounting?.summary.expenses || 0)}</strong>
              </article>
              <article>
                <span>Net profit</span>
                <strong>{money(accounting?.summary.profit || 0)}</strong>
              </article>
              <article>
                <span>Cash / assets</span>
                <strong>{money(accounting?.summary.assets || 0)}</strong>
              </article>
            </section>

            <section className="opsGrid twoCols">
              <article className="panel">
                <div className="panelHeader">
                  <div>
                    <p className="eyebrow">Double entry</p>
                    <h3>Post {business} transaction</h3>
                  </div>
                </div>
                <form className="stackForm" onSubmit={createJournal}>
                  <label>
                    Date
                    <input
                      name="entryDate"
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      required
                    />
                  </label>
                  <label>
                    Type
                    <select name="kind">
                      <option>Revenue</option>
                      <option>Expense</option>
                    </select>
                  </label>
                  <label>
                    Category
                    <select name="accountCode" required>
                      {accountingAccounts.map((account) => (
                        <option key={account.id} value={account.code}>
                          {account.code} · {account.name} ({account.accountType})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Amount
                    <input name="amount" type="number" min="0.01" step="0.01" required />
                  </label>
                  <label>
                    Description
                    <input name="description" required />
                  </label>
                  <label>
                    Reference
                    <input name="reference" placeholder="Receipt, deposit, invoice, etc." />
                  </label>
                  <button className="primary" disabled={busy}>
                    Post entry
                  </button>
                </form>
              </article>

              <article className="panel">
                <div className="panelHeader">
                  <div>
                    <p className="eyebrow">Balance sheet</p>
                    <h3>{business} current balances</h3>
                  </div>
                </div>
                <div className="accountingSummary">
                  <div>
                    <span>Assets</span>
                    <strong>{money(accounting?.summary.assets || 0)}</strong>
                  </div>
                  <div>
                    <span>Liabilities</span>
                    <strong>{money(accounting?.summary.liabilities || 0)}</strong>
                  </div>
                  <div>
                    <span>Equity</span>
                    <strong>{money(accounting?.summary.equity || 0)}</strong>
                  </div>
                  <div>
                    <span>Current earnings</span>
                    <strong>{money(accounting?.summary.profit || 0)}</strong>
                  </div>
                </div>
              </article>
            </section>

            <section className="panel activityPanel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">General ledger</p>
                  <h3>{business} recent journal entries</h3>
                </div>
              </div>
              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th>Reference</th>
                      <th>Source</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(accounting?.recent || []).map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.entryDate}</td>
                        <td>
                          <strong>{entry.description}</strong>
                        </td>
                        <td>{entry.reference || "—"}</td>
                        <td>{entry.source}</td>
                        <td>{money(entry.amount)}</td>
                      </tr>
                    ))}
                    {accounting?.recent.length === 0 && (
                      <tr>
                        <td colSpan={5}>No journal entries have been posted.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
