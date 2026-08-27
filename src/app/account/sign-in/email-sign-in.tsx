"use client";
import { FormEvent, useState } from "react";
export default function EmailSignIn({
  initialError,
}: {
  initialError: string;
}) {
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/customer/auth/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: sent ? "verify" : "request",
            email,
            code,
          }),
        }),
        body = await response.json();
      if (!response.ok) throw new Error(body.error || "Sign-in failed.");
      if (sent) location.href = "/account";
      else setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="customerOrder confirmationPage">
      <section className="confirmationCard">
        <p className="eyebrow">Corner Deli account</p>
        <h1>Sign in</h1>
        <p>
          No password needed. Use Google or receive a one-time code by email.
        </p>
        {error && (
          <p className="orderError" role="alert">
            {error}
          </p>
        )}
        <a
          className="reviewButton confirmationButton"
          href="/api/customer/auth/google"
        >
          Continue with Google
        </a>
        <div className="authDivider">or</div>
        <form onSubmit={submit} className="customerContact">
          <input
            type="email"
            autoComplete="email"
            aria-label="Email address"
            placeholder="Email address"
            required
            value={email}
            disabled={sent}
            onChange={(event) => setEmail(event.target.value)}
          />
          {sent && (
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6-digit code"
              placeholder="6-digit code"
              pattern="[0-9]{6}"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
          <button className="reviewButton" disabled={busy}>
            {busy
              ? "Please wait…"
              : sent
                ? "Verify and sign in"
                : "Email me a code"}
          </button>
        </form>
        {sent && (
          <button
            className="accountLink"
            onClick={() => {
              setSent(false);
              setCode("");
            }}
          >
            Use a different email
          </button>
        )}
        <p className="confirmationEmail">
          You can always order as a guest. An account is not required.
        </p>
      </section>
    </main>
  );
}
