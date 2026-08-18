"use client";

import { useEffect, useMemo, useState } from "react";

type Employee = {
  id: string;
  name: string;
  hasPhone: boolean;
  smsOptIn: boolean;
};

type TestResult = {
  ok?: boolean;
  employee?: string;
  error?: string;
  sms?: {
    configured: boolean;
    sent: number;
    failed: number;
    missingPhone: number;
    notOptedIn: number;
    skipped: number;
    failures: Array<{ employeeId: string; message: string }>;
  };
};

export default function SmsTestPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workforce/test-sms?business=Corner%20Deli", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { employees?: Employee[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load employees.");
        if (cancelled) return;
        const list = payload.employees || [];
        setEmployees(list);
        const chris = list.find((employee) => employee.name.trim().toLowerCase() === "chris")
          || list.find((employee) => employee.name.trim().toLowerCase().startsWith("chris "));
        setEmployeeId(chris?.id || list[0]?.id || "");
      })
      .catch((error) => {
        if (!cancelled) setResult({ error: error instanceof Error ? error.message : "Unable to load employees." });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => employees.find((employee) => employee.id === employeeId) || null,
    [employees, employeeId],
  );

  async function sendTest() {
    if (!employeeId) return;
    setSending(true);
    setResult(null);
    try {
      const response = await fetch("/api/workforce/test-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business: "Corner Deli", employeeId }),
      });
      const payload = await response.json() as TestResult;
      setResult(payload);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : "Unable to send test SMS." });
    } finally {
      setSending(false);
    }
  }

  return <main style={{ maxWidth: 760, margin: "0 auto", padding: "1.25rem" }}>
    <h1>Schedule SMS Test</h1>
    <p>Send one test message through the same Telnyx connection used when schedules are published.</p>

    <div style={{ display: "grid", gap: 12, marginTop: 20, maxWidth: 520 }}>
      <label style={{ display: "grid", gap: 6 }}>
        <strong>Corner Deli employee</strong>
        <select
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
          disabled={loading || sending}
          style={{ padding: "0.7rem", borderRadius: 8 }}
        >
          {employees.map((employee) => <option key={employee.id} value={employee.id}>
            {employee.name}{!employee.hasPhone ? " — no phone" : !employee.smsOptIn ? " — SMS off" : ""}
          </option>)}
        </select>
      </label>

      {selected && <p style={{ margin: 0 }}>
        Phone: {selected.hasPhone ? "on file" : "missing"} · SMS consent: {selected.smsOptIn ? "enabled" : "disabled"}
      </p>}

      <button
        type="button"
        onClick={sendTest}
        disabled={loading || sending || !employeeId || !selected?.hasPhone || !selected?.smsOptIn}
        style={{ padding: "0.8rem 1rem", borderRadius: 8, fontWeight: 800, cursor: "pointer" }}
      >
        {sending ? "Sending test…" : "Send Test SMS"}
      </button>
    </div>

    {result && <section style={{ marginTop: 22, padding: 16, border: "1px solid #334155", borderRadius: 10 }}>
      {result.ok ? <>
        <h2 style={{ marginTop: 0 }}>Telnyx accepted the message</h2>
        <p style={{ marginBottom: 0 }}>One SMS was submitted successfully to {result.employee}. Check the phone for delivery.</p>
      </> : <>
        <h2 style={{ marginTop: 0 }}>SMS test failed</h2>
        <p>{result.error || result.sms?.failures?.[0]?.message || "Telnyx did not accept the message."}</p>
        {result.sms && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(result.sms, null, 2)}</pre>}
      </>}
    </section>}
  </main>;
}
