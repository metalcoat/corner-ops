"use client";

import { FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../employee.css";

async function message(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function EmployeeResetPinPage() {
  const params = useSearchParams();
  const token = useMemo(() => params.get("token") || "", [params]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/employee/pin-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, pin: form.get("pin"), confirmation: form.get("confirmation") }),
      });
      if (!response.ok) throw new Error(await message(response));
      setComplete(true);
      setNotice("PIN changed. You can now sign in to Employee Hub with the new PIN.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PIN reset failed.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="employeeLoginShell"><section className="employeeLoginCard">
    <p className="empEyebrow">Employee Hub account recovery</p>
    <h1>Choose a new PIN</h1>
    {!token && <div className="empNotice">The reset token is missing. Request another reset email.</div>}
    {notice && <div className="empNotice">{notice}</div>}
    {!complete && token && <form className="employeeLoginForm" onSubmit={submit}>
      <label>New five-digit PIN<input name="pin" inputMode="numeric" pattern="\d{5}" maxLength={5} autoComplete="off" required /></label>
      <label>Confirm PIN<input name="confirmation" inputMode="numeric" pattern="\d{5}" maxLength={5} autoComplete="off" required /></label>
      <button disabled={busy}>{busy ? "Changing…" : "Change PIN"}</button>
    </form>}
    <a href="/employee" className="empClockLink">Return to Employee Hub</a>
    <a href="/employee/forgot-pin" className="empClockLink">Request another link</a>
  </section></main>;
}
