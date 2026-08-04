"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../ops/control-center.css";

async function message(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function ResetPasswordForm() {
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
      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: form.get("password"), confirmation: form.get("confirmation") }),
      });
      if (!response.ok) throw new Error(await message(response));
      setComplete(true);
      setNotice("Password changed. You can now sign in with the new password.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Password reset failed.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="controlPage" style={{ display: "grid", placeItems: "center" }}>
    <section className="controlCard" style={{ maxWidth: 540, width: "100%" }}>
      <p className="eyebrow">Corner Ops account recovery</p>
      <h1>Choose a new password</h1>
      {!token && <div className="noticeBar">The reset token is missing. Request another reset email.</div>}
      {notice && <div className="noticeBar">{notice}</div>}
      {!complete && token && <form className="controlForm" onSubmit={submit}>
        <label className="wide">New password<input name="password" type="password" minLength={10} autoComplete="new-password" required autoFocus /></label>
        <label className="wide">Confirm password<input name="confirmation" type="password" minLength={10} autoComplete="new-password" required /></label>
        <button className="primary" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
      </form>}
      <div className="controlActions"><a href="/signin">Return to sign-in</a><a href="/forgot-password">Request another link</a></div>
    </section>
  </main>;
}

export default function ResetPasswordPage() {
  return <Suspense fallback={<main className="controlPage" style={{ display: "grid", placeItems: "center" }}><section className="controlCard"><h1>Loading reset link…</h1></section></main>}>
    <ResetPasswordForm />
  </Suspense>;
}
