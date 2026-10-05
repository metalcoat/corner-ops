"use client";
// Always-on screens (status board, label station) sign in once and then stay
// signed in for good. Shows the screen once it has its pass; otherwise lets
// someone sign in (POS PIN or office login) and keep the screen signed in.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./screen-gate.css";

type Kind = "board" | "labels";
const TITLES: Record<Kind, string> = { board: "Status board", labels: "Label station" };

export default function ScreenGate({ kind, children }: { kind: Kind; children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "signin" | "keep">("loading");
  const [pin, setPin] = useState("");
  const [name, setName] = useState(TITLES[kind]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      const response = await fetch(`/api/pos/screen?kind=${kind}`, { cache: "no-store" });
      const body = await response.json();
      setState(body.screen ? "ready" : body.signedIn ? "keep" : "signin");
    } catch {
      setError("Can't reach Corner Ops. Check the internet connection.");
      setState("signin");
    }
  }, [kind]);
  useEffect(() => {
    void check();
    // If a manager signs this screen out from Settings, show the sign-in again.
    const lost = () => void check();
    window.addEventListener("corner-ops-screen-signed-out", lost);
    return () => window.removeEventListener("corner-ops-screen-signed-out", lost);
  }, [check]);

  async function keep(dropPosSession: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pos/screen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, name }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not keep this screen signed in.");
      // The screen has its own pass now; don't leave an employee signed in here.
      if (dropPosSession) await fetch("/api/pos/session", { method: "DELETE" }).catch(() => undefined);
      setState("ready");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not keep this screen signed in.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pos/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      const body = await response.json().catch(() => ({}));
      setPin("");
      if (!response.ok) throw new Error(body.error || "PIN not recognized.");
      setBusy(false);
      await keep(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PIN not recognized.");
      setBusy(false);
    }
  }

  if (state === "ready") return <>{children}</>;
  if (state === "loading") return <main className="screenGate"><p>Loading…</p></main>;
  return (
    <main className="screenGate">
      <section>
        <p className="screenEyebrow">CORNER DELI · {TITLES[kind].toUpperCase()}</p>
        {state === "keep" ? (
          <>
            <h1>Keep this screen signed in?</h1>
            <p>It will stay on the {TITLES[kind].toLowerCase()} and never time out. A manager can sign it out any time under Settings → Printers &amp; devices.</p>
            <label>
              Name this screen
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "board" ? "Front monitor" : "Sub station"} />
            </label>
            <button disabled={busy} onClick={() => void keep(false)}>{busy ? "Saving…" : "Keep signed in"}</button>
          </>
        ) : (
          <>
            <h1>Sign in once</h1>
            <p>Use any employee PIN. This screen then stays signed in for good and never times out.</p>
            <form onSubmit={signInWithPin}>
              <label>
                Name this screen
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Employee PIN
                <input inputMode="numeric" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 5))} />
              </label>
              <button disabled={busy || pin.length < 4}>{busy ? "Signing in…" : "Sign in"}</button>
            </form>
            <a className="screenAlt" href={`/signin?returnTo=${encodeURIComponent(kind === "board" ? "/pos/board" : "/pos/labels")}`}>
              Or sign in with the office login
            </a>
          </>
        )}
        {error && <p className="screenError" role="alert">{error}</p>}
      </section>
    </main>
  );
}
