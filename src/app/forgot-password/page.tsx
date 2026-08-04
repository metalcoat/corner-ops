"use client";

import { FormEvent, useState } from "react";
import "../ops/control-center.css";

async function message(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  return payload?.message || payload?.error || `Request failed (${response.status}).`;
}

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      setNotice(await message(response));
    } catch {
      setNotice("The request could not be sent. Try again from the sign-in page.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="controlPage" style={{ display: "grid", placeItems: "center" }}>
    <section className="controlCard" style={{ maxWidth: 540, width: "100%" }}>
      <p className="eyebrow">Corner Ops account recovery</p>
      <h1>Reset your password</h1>
      <p>Enter the email used for your owner, co-owner, accountant, manager, or viewer account.</p>
      <form className="controlForm" onSubmit={submit}>
        <label className="wide">Account email<input name="email" type="email" autoComplete="email" required autoFocus /></label>
        {notice && <div className="noticeBar wide">{notice}</div>}
        <button className="primary" disabled={busy}>{busy ? "Sending…" : "Email reset link"}</button>
        <a href="/signin">Back to sign-in</a>
        <a href="/employee/forgot-pin">Employee PIN reset</a>
      </form>
    </section>
  </main>;
}
