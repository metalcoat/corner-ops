"use client";

import { useEffect, useState } from "react";

type BoardRow = { rank: number; name: string; correct: number; you?: boolean };
type Period = "today" | "month" | "year";
type Question = { id: string; topic: string; q: string; choices: string[]; number: number };
type Day = { answered: number; correct: number; left: number; question: Question | null };
type State = {
  enabled: boolean; playingUntil: number; player: { id: number; name: string; linked: boolean } | null;
  day: Day | null; totals: Record<Period, number> | null; boards: Record<Period, BoardRow[]>;
};
type Result = { correct: boolean; chosen: string; correctLetter: string; correctAnswer: string };

const LETTERS = ["A", "B", "C", "D"];
const PERIOD_NAMES: Record<Period, string> = { today: "Today", month: "This month", year: "This year" };
const DAILY = 15;

async function call(body?: object): Promise<State & { result?: Result }> {
  const response = await fetch("/api/customer/trivia", body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || "Something went wrong. Try again."), { status: response.status });
  return payload;
}

export default function TriviaClient({ token }: { token: string }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(Result & { question: Question }) | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [period, setPeriod] = useState<Period>("today");

  async function run(body?: object) {
    setBusy(true);
    setError("");
    try {
      const next = await call(body);
      setState(next);
      return next;
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError((failure as Error).message);
      // The scan ran out or trivia was paused: show the latest state behind the message.
      if (status === 403 || status === 409 || status === 401) setState(await call().catch(() => null));
      return null;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (token) {
      // Take the code out of the address bar so a bookmark or screenshot doesn't carry it.
      window.history.replaceState(null, "", "/trivia");
      void run({ action: "scan", token });
    } else void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function answer(question: Question, letter: string) {
    const next = await run({ action: "answer", questionId: question.id, choice: letter });
    if (next?.result) setResult({ ...next.result, question });
  }

  async function nextQuestion() {
    setResult(null);
    await run({ action: "next" });
  }

  if (!state) {
    return <main className="trv"><Header /><section className="trvCard">{error ? <p className="trvError">{error}</p> : <p>Loading…</p>}</section></main>;
  }

  const playing = state.enabled && state.playingUntil > Date.now();
  const day = state.day;
  let body: React.ReactNode;
  if (!state.enabled) {
    body = <section className="trvCard"><h2>Trivia is paused</h2><p>Lobby trivia is taking a break right now. Check back another time!</p></section>;
  } else if (!playing) {
    body = <section className="trvCard"><h2>Scan the TV to play</h2><p>Scan the trivia code on the TV inside Corner Deli to {state.player ? "keep playing" : "start"}. Each code only works for a couple of minutes.</p>{state.player && day ? <p className="trvMuted">{day.answered} of {DAILY} answered today, {day.correct} right.</p> : null}</section>;
  } else if (!state.player || renaming) {
    body = <section className="trvCard">
      <h2>{renaming ? "Change your nickname" : "Pick a nickname"}</h2>
      <p>It shows on the TV leaderboard. Keep it friendly!</p>
      <form className="trvName" onSubmit={async (event) => { event.preventDefault(); if (await run({ action: "join", name })) setRenaming(false); }}>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={16} autoComplete="nickname" autoCapitalize="words" placeholder="Nickname" aria-label="Nickname" autoFocus />
        <button className="trvPrimary" disabled={busy || name.trim().length < 2}>{renaming ? "Save" : "Start"}</button>
      </form>
      {renaming && <button className="trvLink" onClick={() => setRenaming(false)}>Cancel</button>}
    </section>;
  } else if (result) {
    body = <section className={`trvCard trvResult ${result.correct ? "right" : "wrong"}`}>
      <h2>{result.correct ? "You got it!" : "Not quite"}</h2>
      <p className="trvQ">{result.question.q}</p>
      <p>The answer is <strong>{result.correctLetter}. {result.correctAnswer}</strong></p>
      {day && <p className="trvMuted">{day.correct} right out of {day.answered} today.</p>}
      {day && day.left > 0
        ? <button className="trvPrimary" onClick={() => void nextQuestion()} disabled={busy}>Next question</button>
        : <p><strong>That&apos;s all {DAILY} for today.</strong> Come back tomorrow for more!</p>}
    </section>;
  } else if (day?.question) {
    const question = day.question;
    body = <section className="trvCard">
      <p className="trvTopic">{question.topic} · Question {question.number} of {DAILY}</p>
      <h2 className="trvQ">{question.q}</h2>
      <div className="trvChoices">
        {question.choices.map((choice, index) => (
          <button key={LETTERS[index]} disabled={busy} onClick={() => void answer(question, LETTERS[index])}><b>{LETTERS[index]}</b><span>{choice}</span></button>
        ))}
      </div>
    </section>;
  } else if (day && day.left === 0) {
    body = <section className="trvCard"><h2>All done for today!</h2><p>You got <strong>{day.correct} of {DAILY}</strong> right. New questions tomorrow.</p></section>;
  } else {
    body = <section className="trvCard"><button className="trvPrimary" onClick={() => void nextQuestion()} disabled={busy}>Next question</button></section>;
  }

  return (
    <main className="trv">
      <Header name={state.player?.name} onRename={state.player && playing ? () => { setName(state.player!.name); setRenaming(true); } : undefined} />
      {error && <p className="trvError" role="alert">{error}</p>}
      {body}
      {state.totals && <section className="trvTotals">
        {(["today", "month", "year"] as Period[]).map((key) => <div key={key}><strong>{state.totals![key]}</strong><span>{PERIOD_NAMES[key]}</span></div>)}
      </section>}
      <section className="trvCard trvBoard">
        <h2>Leaderboard</h2>
        <div className="trvTabs" role="tablist">
          {(["today", "month", "year"] as Period[]).map((key) => <button key={key} role="tab" aria-selected={period === key} className={period === key ? "on" : ""} onClick={() => setPeriod(key)}>{PERIOD_NAMES[key]}</button>)}
        </div>
        {state.boards[period].length
          ? <ol>{state.boards[period].map((row) => <li key={row.rank} className={row.you ? "you" : ""}><b>{row.rank}</b><span>{row.name}{row.you ? " (you)" : ""}</span><em>{row.correct}</em></li>)}</ol>
          : <p className="trvMuted">No correct answers yet. Be the first!</p>}
        <p className="trvMuted">Most correct answers wins; a tie goes to whoever got there first.</p>
      </section>
      {state.player && !state.player.linked && <PhoneLink onLinked={() => void run({ action: "link" })} />}
      <p className="trvFoot">Just for fun: no prizes or points. Up to {DAILY} questions a day.</p>
    </main>
  );
}

function Header({ name, onRename }: { name?: string; onRename?: () => void }) {
  return <header className="trvHead">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/corner-deli-logo.png" alt="" />
    <div><h1>Lobby Trivia</h1><p>Corner Deli{name ? <> · playing as <strong>{name}</strong>{onRename && <button className="trvLink" onClick={onRename}>change</button>}</> : null}</p></div>
  </header>;
}

/** Optional: sign in with a texted code (the ordering site's sign-in) so monthly and yearly scores follow you to a new phone. */
function PhoneLink({ onLinked }: { onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(action: "request" | "verify") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/customer/auth/phone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, phone, code }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "That didn't work. Try again.");
      if (action === "request") { setSent(true); setMessage(payload.testCode ? `Test code: ${payload.testCode}` : "We texted you a 6-digit code."); }
      else onLinked();
    } catch (failure) {
      setMessage((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <section className="trvCard trvPhone"><p>Keep your monthly and yearly score if you switch phones.</p><button className="trvLink" onClick={() => setOpen(true)}>Add your phone number</button></section>;
  return <section className="trvCard trvPhone">
    <h2>Add your phone number</h2>
    <p className="trvMuted">We text a code once to check it&apos;s yours. It&apos;s never shown on the TV.</p>
    <form className="trvName" onSubmit={(event) => { event.preventDefault(); void send(sent ? "verify" : "request"); }}>
      {sent
        ? <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="Code" />
        : <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="Mobile number" aria-label="Mobile number" />}
      <button className="trvPrimary" disabled={busy}>{sent ? "Confirm" : "Text me a code"}</button>
    </form>
    {message && <p role="status">{message}</p>}
  </section>;
}
