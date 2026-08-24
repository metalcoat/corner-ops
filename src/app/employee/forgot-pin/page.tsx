"use client";

import { requestFailure } from "@/app/client-http";
import { FormEvent, useState } from "react";
import "../employee.css";

async function message(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  return payload?.message || payload?.error || requestFailure(response);
}

export default function EmployeeForgotPinPage() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/employee/pin-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), business: form.get("business") }),
      });
      setNotice(await message(response));
    } catch {
      setNotice("The request could not be sent. Try again from Employee Hub.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="employeeLoginShell"><section className="employeeLoginCard">
    <p className="empEyebrow">Employee Hub account recovery</p>
    <h1>Reset your five-digit PIN</h1>
    <p>The reset email must match the email saved in your employee profile.</p>
    {notice && <div className="empNotice">{notice}</div>}
    <form className="employeeLoginForm" onSubmit={submit}>
      <label>Location<select name="business" defaultValue="Corner Deli"><option>Corner Deli</option><option>Tiki</option></select></label>
      <label>Employee email<input name="email" type="email" autoComplete="email" required /></label>
      <button disabled={busy}>{busy ? "Sending…" : "Email PIN reset link"}</button>
    </form>
    <a href="/employee" className="empClockLink">Back to Employee Hub</a>
    <a href="/forgot-password" className="empClockLink">Owner and staff account reset</a>
  </section></main>;
}
