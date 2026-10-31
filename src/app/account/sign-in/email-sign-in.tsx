"use client";
import { FormEvent, useState } from "react";
export default function EmailSignIn({
  initialError,
}: {
  initialError: string;
}) {
  const [email, setEmail] = useState(""),
    [phone, setPhone] = useState(""),
    [method, setMethod] = useState<"email" | "phone">("email"),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/customer/auth/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: sent ? "verify" : "request",
            ...(method === "email" ? { email } : { phone }),
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
      <section className="confirmationCard accountSignInCard">
        <p className="eyebrow">Corner Deli account</p>
        <h1>Sign in</h1>
        <p>No password needed. We’ll send you a secure one-time code.</p>
        {error && (
          <p className="orderError" role="alert">
            {error}
          </p>
        )}
        <strong className="authMethodLabel">Log in with</strong>
        <div className="authMethodGrid" aria-label="Login method">
          <a className="choiceButton googleAuthChoice" href="/api/customer/auth/google">Google</a>
          <button type="button" className="choiceButton" aria-pressed={method === "email"} disabled={sent} onClick={() => setMethod("email")}>Email</button>
          <button type="button" className="choiceButton" aria-pressed={method === "phone"} disabled={sent} onClick={() => setMethod("phone")}>SMS</button>
        </div>
        <form onSubmit={submit} className="customerContact authContactForm">
          <label htmlFor="account-login-value">Enter your {method === "email" ? "email" : "mobile phone number"}</label>
          {method === "email" ? (
            <input
              id="account-login-value"
              type="email"
              autoComplete="email"
              aria-label="Email address"
              placeholder="Email address"
              required
              value={email}
              disabled={sent}
              onChange={(event) => setEmail(event.target.value)}
            />
          ) : (
            <input
              id="account-login-value"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              aria-label="Mobile phone number"
              placeholder="Mobile phone number"
              required
              value={phone}
              disabled={sent}
              onChange={(event) => setPhone(event.target.value)}
            />
          )}
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
                : method === "email" ? "Email me a code" : "Text me a code"}
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
            Use a different {method === "email" ? "email" : "phone number"}
          </button>
        )}
        <p className="confirmationEmail">
          You can always order as a guest. An account is not required.
        </p>
      </section>
    </main>
  );
}
