"use client";

import { FormEvent, useEffect, useState } from "react";
import { responseMessage } from "@/app/client-http";

export default function EmployeeEmailPrompt() {
  const [checked, setChecked] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/employee/contact", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return;
        if (!response.ok) throw new Error(await responseMessage(response));
        const payload = await response.json() as { email?: string };
        setMissing(!String(payload.email || "").trim());
      })
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setMissing(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Email address could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!checked || !missing) return null;

  return <section style={{ border: "1px solid currentColor", borderRadius: 12, padding: 16, margin: "12px 0" }} aria-labelledby="employee-email-title">
    <p style={{ margin: "0 0 4px", fontWeight: 700 }}>Onboarding required</p>
    <h2 id="employee-email-title" style={{ margin: "0 0 8px" }}>Add your email address</h2>
    <p style={{ margin: "0 0 12px" }}>Corner Ops does not have an email address for you yet. Add one for employment records and PIN recovery.</p>
    <form onSubmit={save} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
      <label style={{ display: "grid", gap: 4, flex: "1 1 240px" }}>Email address<input name="email" type="email" autoComplete="email" required autoFocus /></label>
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save email"}</button>
    </form>
    {notice && <p role="alert" style={{ marginBottom: 0 }}>{notice}</p>}
  </section>;
}
