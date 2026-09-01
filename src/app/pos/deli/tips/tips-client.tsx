"use client";
import { useCallback, useEffect, useState } from "react";
const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
type Data = {
  policy: any;
  summary: any[];
  employees: any[];
  allocations: any[];
  batches: any[];
};
export default function TipsClient() {
  const [data, setData] = useState<Data | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [period, setPeriod] = useState({ start: "", end: "", notes: "" });
  const load = useCallback(async () => {
    const response = await fetch("/api/ordering/tips", { cache: "no-store" }),
      body = await response.json();
    if (!response.ok) throw new Error(body.error || "Tips unavailable.");
    setData(body);
  }, []);
  useEffect(() => {
    void load().catch((error) => setMessage(error.message));
  }, [load]);
  async function act(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/ordering/tips", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        result = await response.json();
      if (!response.ok) throw new Error(result.error || "Tip update failed.");
      await load();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Tip update failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <main className="tipsPage">
        <h1>Tip accounting</h1>
        <p role="alert">{message || "Loading…"}</p>
      </main>
    );
  const eligible = data.summary
      .filter((row) => row.status === "eligible")
      .reduce((n, row) => n + Number(row.amount_cents), 0),
    unassigned = data.summary
      .filter((row) => row.status === "unassigned")
      .reduce((n, row) => n + Number(row.amount_cents), 0),
    paid = data.summary
      .filter((row) => row.status === "paid")
      .reduce((n, row) => n + Number(row.amount_cents), 0);
  return (
    <main className="tipsPage">
      <header>
        <div>
          <span>PAYROLL READY</span>
          <h1>Tip accounting</h1>
        </div>
        <a href="/api/ordering/tips?export=csv">EXPORT CSV</a>
      </header>
      {message && (
        <p className="tipsMessage" role="status">
          {message}
        </p>
      )}
      <section className="tipMetrics">
        <article>
          <span>Ready to pay</span>
          <strong>{money(eligible)}</strong>
        </article>
        <article>
          <span>Unassigned</span>
          <strong>{money(unassigned)}</strong>
        </article>
        <article>
          <span>Paid history</span>
          <strong>{money(paid)}</strong>
        </article>
      </section>
      <section className="tipGrid">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              {
                action: "policy",
                deliveryPolicy: data.policy.delivery_policy,
                counterPolicy: data.policy.counter_policy,
                poolClockedInOnly: data.policy.pool_clocked_in_only,
              },
              "Tip policy saved.",
            );
          }}
        >
          <h2>Ownership policy</h2>
          <label>
            Delivery tips
            <select
              value={data.policy.delivery_policy}
              onChange={(e) =>
                setData({
                  ...data,
                  policy: { ...data.policy, delivery_policy: e.target.value },
                })
              }
            >
              <option value="assigned_driver">Assigned driver</option>
              <option value="order_taker">Order taker</option>
              <option value="pool">Clocked-in pool</option>
            </select>
          </label>
          <label>
            Counter / pickup tips
            <select
              value={data.policy.counter_policy}
              onChange={(e) =>
                setData({
                  ...data,
                  policy: { ...data.policy, counter_policy: e.target.value },
                })
              }
            >
              <option value="order_taker">Cashier / order taker</option>
              <option value="pool">Clocked-in pool</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={data.policy.pool_clocked_in_only}
              onChange={(e) =>
                setData({
                  ...data,
                  policy: {
                    ...data.policy,
                    pool_clocked_in_only: e.target.checked,
                  },
                })
              }
            />{" "}
            Pool only employees clocked in when paid
          </label>
          <button disabled={busy}>SAVE POLICY</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              {
                action: "payout",
                periodStart: period.start || null,
                periodEnd: period.end || null,
                notes: period.notes,
              },
              "Payout batch posted.",
            );
          }}
        >
          <h2>Post payout</h2>
          <label>
            Period start
            <input
              type="date"
              value={period.start}
              onChange={(e) => setPeriod({ ...period, start: e.target.value })}
            />
          </label>
          <label>
            Period end
            <input
              type="date"
              value={period.end}
              onChange={(e) => setPeriod({ ...period, end: e.target.value })}
            />
          </label>
          <label>
            Notes
            <input
              value={period.notes}
              onChange={(e) => setPeriod({ ...period, notes: e.target.value })}
            />
          </label>
          <strong>{money(eligible)} across all employees</strong>
          <button disabled={busy || eligible <= 0}>
            PAY ALL ELIGIBLE TIPS
          </button>
        </form>
      </section>
      <section>
        <h2>Employee balances</h2>
        <div className="tipTable">
          <div className="head">
            <span>Employee</span>
            <span>Eligible</span>
            <span>Paid</span>
            <span></span>
          </div>
          {data.employees.map((row) => (
            <div key={row.employee_id}>
              <span>{row.employee_name}</span>
              <strong>{money(Number(row.eligible_cents || 0))}</strong>
              <span>{money(Number(row.paid_cents || 0))}</span>
              <button
                disabled={busy || Number(row.eligible_cents || 0) <= 0}
                onClick={() =>
                  void act(
                    {
                      action: "payout",
                      employeeId: row.employee_id,
                      periodStart: period.start || null,
                      periodEnd: period.end || null,
                      notes: period.notes,
                    },
                    `Payout posted for ${row.employee_name}.`,
                  )
                }
              >
                PAY EMPLOYEE
              </button>
            </div>
          ))}
        </div>
      </section>
      {unassigned > 0 && (
        <section>
          <h2>Needs assignment</h2>
          <div className="tipTable unassigned">
            {data.allocations
              .filter((row) => row.status === "unassigned")
              .map((row) => (
                <div key={row.id}>
                  <span>
                    Order #{row.display_number} ·{" "}
                    {String(row.service_type).replaceAll("_", " ")}
                  </span>
                  <strong>{money(Number(row.amount_cents))}</strong>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value)
                        void act(
                          {
                            action: "assign",
                            id: row.id,
                            employeeId: e.target.value,
                          },
                          "Tip assigned.",
                        );
                    }}
                  >
                    <option value="">Assign employee…</option>
                    {data.employees.map((employee) => (
                      <option
                        key={employee.employee_id}
                        value={employee.employee_id}
                      >
                        {employee.employee_name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
          </div>
        </section>
      )}
      <section>
        <h2>Payout batches</h2>
        <div className="tipTable batches">
          <div className="head">
            <span>Date</span>
            <span>Employees</span>
            <span>Total</span>
            <span>Status</span>
            <span></span>
          </div>
          {data.batches.map((row) => (
            <div key={row.id}>
              <span>{new Date(row.created_at).toLocaleString()}</span>
              <span>{row.employee_count}</span>
              <strong>{money(Number(row.total_cents))}</strong>
              <span>{row.status}</span>
              {row.status === "posted" ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      { action: "reverse_payout", id: row.id },
                      "Payout batch reversed.",
                    )
                  }
                >
                  REVERSE
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
