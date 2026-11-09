"use client";
// The deli's checklist screen: tap an item (or a salad), type a PIN once, and keep tapping for a few minutes as
// that person. Built to stay out of the way: one tap per job, and "Mark the rest done" for the end of the night.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultChecklistId } from "@/lib/store-checklist-rules";

type Check = { id: number; employeeName: string; checkedAt: string };
type Item = { id: string; label: string; check: Check | null };
type List = { id: string; name: string; opensAtHour: number; items: Item[] };
type Salad = { id: string; name: string };
type Batch = { id: number; businessDate: string; saladId: string; saladName: string; employeeName: string; madeAt: string; batchSize: string; notes: string };
type Screen = { businessDate: string; lists: List[]; salads: Salad[]; batches: Batch[] };
type Worker = { employeeId: string; name: string; expiresAt: number };
type Action =
  | { action: "check"; itemIds: string[]; bulk?: boolean }
  | { action: "uncheck"; itemId: string; reason: string }
  | { action: "salad"; saladId: string }
  | { action: "batch"; id: number; batchSize: string; notes: string }
  | { action: "void-batch"; id: number; reason: string };

const SALADS = "salads";
const UNDO_REASONS = ["Tapped by mistake", "Not done right", "Needs doing again"];
const BATCH_SIZES = ["Half pan", "Full pan", "2 pans", "Small tub"];
const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const dayTime = (iso: string, today: string, businessDate: string) =>
  businessDate === today ? `Today ${time(iso)}` : new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const first = (name: string) => name.split(/\s+/)[0];

export default function ChecklistsScreen() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [tab, setTab] = useState<string>("");
  const [worker, setWorker] = useState<Worker | null>(null);
  const token = useRef("");
  const [pinFor, setPinFor] = useState<Action | null>(null);
  const [undo, setUndo] = useState<{ item: Item } | null>(null);
  const [confirmAll, setConfirmAll] = useState<List | null>(null);
  const [logged, setLogged] = useState<Batch | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/checklists", { cache: "no-store" });
      const body = await response.json();
      if (response.status === 401) window.dispatchEvent(new Event("corner-ops-screen-signed-out"));
      if (!response.ok) throw new Error(body.error || "Can't load the checklists.");
      setScreen(body);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Can't reach Corner Ops.");
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Sign the person out when their pass runs out, so the next tap asks for a PIN.
  useEffect(() => {
    if (worker && worker.expiresAt <= now) {
      setWorker(null);
      token.current = "";
    }
  }, [now, worker]);
  // Open on the list for this time of day (Opening in the morning, Closing at night); a new day starts there again.
  const shownDay = useRef("");
  useEffect(() => {
    if (!screen) return;
    const newDay = Boolean(shownDay.current) && shownDay.current !== screen.businessDate;
    shownDay.current = screen.businessDate;
    setTab((current) => !newDay && current && (current === SALADS || screen.lists.some((list) => list.id === current)) ? current : defaultChecklistId(screen.lists, new Date()) || SALADS);
  }, [screen]);

  function signOut() {
    setWorker(null);
    token.current = "";
  }

  async function run(action: Action) {
    if (!token.current) {
      setPinFor(action);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pos/checklists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...action, token: token.current }) });
      const body = await response.json();
      if (body.signedOut) {
        signOut();
        setPinFor(action);
        return;
      }
      if (!response.ok) throw new Error(body.error || "That didn't save. Try again.");
      token.current = body.token;
      setWorker(body.worker);
      setScreen(body.screen);
      if (action.action === "salad" && body.batch) setLogged(body.batch);
      if (action.action === "batch" || action.action === "void-batch") setLogged(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signIn(pin: string) {
    const response = await fetch("/api/pos/checklists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signin", pin }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "PIN not recognized.");
    token.current = body.token;
    setWorker(body.worker);
    const pending = pinFor;
    setPinFor(null);
    if (pending) await run(pending);
  }

  const list = screen?.lists.find((entry) => entry.id === tab);
  const todayBatches = useMemo(() => screen?.batches.filter((batch) => batch.businessDate === screen.businessDate) || [], [screen]);
  if (!screen) return <main className="checklistScreen"><p className="ckEmpty">{error || "Loading…"}</p></main>;
  const left = worker ? Math.max(0, Math.ceil((worker.expiresAt - now) / 1000)) : 0;

  return (
    <main className="checklistScreen">
      <header className="ckHeader">
        <div>
          <p>CORNER DELI</p>
          <h1>Checklists</h1>
        </div>
        {worker ? (
          <div className="ckWorker">
            <span>Checking off as</span>
            <strong>{worker.name}</strong>
            <small>Signs out in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} if idle</small>
            <button type="button" onClick={signOut}>Done — sign out</button>
          </div>
        ) : (
          <div className="ckWorker idle"><span>Tap a job when it&apos;s done.</span><small>It asks for your PIN once, then you can keep tapping.</small></div>
        )}
      </header>

      <nav className="ckTabs" aria-label="Lists">
        {screen.lists.map((entry) => {
          const done = entry.items.filter((item) => item.check).length;
          const complete = entry.items.length > 0 && done === entry.items.length;
          return (
            <button type="button" key={entry.id} className={`${tab === entry.id ? "active" : ""}${complete ? " complete" : ""}`} aria-pressed={tab === entry.id} onClick={() => setTab(entry.id)}>
              <strong>{entry.name}</strong>
              <small>{complete ? "✓ All done" : `${done} / ${entry.items.length}`}</small>
            </button>
          );
        })}
        <button type="button" className={tab === SALADS ? "active" : ""} aria-pressed={tab === SALADS} onClick={() => setTab(SALADS)}>
          <strong>Deli salads</strong>
          <small>{todayBatches.length ? `${todayBatches.length} made today` : "None made today"}</small>
        </button>
      </nav>

      {error && <p className="ckError" role="alert">{error}</p>}

      {list && (() => {
        const done = list.items.filter((item) => item.check).length;
        const remaining = list.items.filter((item) => !item.check);
        return (
          <section className="ckList" aria-label={list.name}>
            <div className="ckProgress">
              <strong>{done} of {list.items.length} done</strong>
              <span><i style={{ width: `${list.items.length ? (done / list.items.length) * 100 : 0}%` }} /></span>
            </div>
            {list.items.length === 0 && <p className="ckEmpty">Nothing on this list yet. A manager can add jobs in Settings.</p>}
            <div className="ckItems">
              {list.items.map((item) => (
                <button type="button" key={item.id} disabled={busy} className={item.check ? "ckItem done" : "ckItem"}
                  onClick={() => (item.check ? setUndo({ item }) : void run({ action: "check", itemIds: [item.id] }))}>
                  <span className="ckBox" aria-hidden>{item.check ? "✓" : ""}</span>
                  <span className="ckLabel">
                    <strong>{item.label}</strong>
                    {item.check && <small>{first(item.check.employeeName)} · {time(item.check.checkedAt)}</small>}
                  </span>
                </button>
              ))}
            </div>
            {remaining.length > 1 && (
              <button type="button" className="ckAll" disabled={busy} onClick={() => setConfirmAll(list)}>
                Mark the rest done ({remaining.length})
              </button>
            )}
          </section>
        );
      })()}

      {tab === SALADS && (
        <section className="ckSalads" aria-label="Deli salads">
          <p className="ckHint">Made a fresh batch? Tap the salad.</p>
          <div className="ckSaladGrid">
            {screen.salads.map((salad) => {
              const last = screen.batches.find((batch) => batch.saladId === salad.id);
              return (
                <button type="button" key={salad.id} disabled={busy} className="ckSalad" onClick={() => void run({ action: "salad", saladId: salad.id })}>
                  <strong>{salad.name}</strong>
                  <small>{last ? `Last: ${dayTime(last.madeAt, screen.businessDate, last.businessDate)} · ${first(last.employeeName)}` : "No batch in the last 3 days"}</small>
                </button>
              );
            })}
          </div>
          {screen.salads.length === 0 && <p className="ckEmpty">No salads set up. A manager can add them in Settings.</p>}
          <h2>Recent batches</h2>
          {screen.batches.length === 0 && <p className="ckEmpty">None in the last 3 days.</p>}
          <ul className="ckBatches">
            {screen.batches.slice(0, 20).map((batch) => (
              <li key={batch.id}>
                <strong>{batch.saladName}</strong>
                <span>{dayTime(batch.madeAt, screen.businessDate, batch.businessDate)} · {batch.employeeName}</span>
                {(batch.batchSize || batch.notes) && <small>{[batch.batchSize, batch.notes].filter(Boolean).join(" · ")}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {pinFor && <PinPad onCancel={() => setPinFor(null)} onPin={signIn} title={pinFor.action === "salad" ? "Who made it?" : pinFor.action === "uncheck" ? "Who is un-checking?" : "Who did it?"} />}

      {undo && (
        <div className="ckModal" role="dialog" aria-modal="true" aria-label="Un-check">
          <section>
            <h2>Un-check “{undo.item.label}”?</h2>
            {undo.item.check && <p>Checked off by {undo.item.check.employeeName} at {time(undo.item.check.checkedAt)}.</p>}
            <p>Why?</p>
            <div className="ckChoices">
              {UNDO_REASONS.map((reason) => (
                <button type="button" key={reason} disabled={busy} onClick={() => { const item = undo.item; setUndo(null); void run({ action: "uncheck", itemId: item.id, reason }); }}>{reason}</button>
              ))}
            </div>
            <button type="button" className="ckCancel" onClick={() => setUndo(null)}>Keep it checked</button>
          </section>
        </div>
      )}

      {confirmAll && (
        <div className="ckModal" role="dialog" aria-modal="true" aria-label="Mark the rest done">
          <section>
            <h2>Mark the rest of {confirmAll.name} done?</h2>
            <ul>{confirmAll.items.filter((item) => !item.check).map((item) => <li key={item.id}>{item.label}</li>)}</ul>
            <p>{worker ? `They'll be checked off as ${worker.name}.` : "You'll type your PIN next."}</p>
            <div className="ckChoices">
              <button type="button" className="ckYes" disabled={busy} onClick={() => { const target = confirmAll; setConfirmAll(null); void run({ action: "check", itemIds: target.items.filter((item) => !item.check).map((item) => item.id), bulk: true }); }}>Yes, all done</button>
              <button type="button" className="ckCancel" onClick={() => setConfirmAll(null)}>Cancel</button>
            </div>
          </section>
        </div>
      )}

      {logged && <BatchSheet batch={logged} busy={busy} onClose={() => setLogged(null)} onSave={(batchSize, notes) => void run({ action: "batch", id: logged.id, batchSize, notes })} onUndo={() => void run({ action: "void-batch", id: logged.id, reason: "Tapped by mistake" })} />}
    </main>
  );
}

/** Shown after a salad is logged: optional size and note, or undo a mis-tap. Closes itself after a while. */
function BatchSheet({ batch, busy, onClose, onSave, onUndo }: { batch: Batch; busy: boolean; onClose: () => void; onSave: (size: string, notes: string) => void; onUndo: () => void }) {
  const [size, setSize] = useState(batch.batchSize);
  const [notes, setNotes] = useState(batch.notes);
  const [editing, setEditing] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (editing) return;
    const timer = window.setTimeout(() => close.current(), 12_000);
    return () => window.clearTimeout(timer);
  }, [editing, batch.id]);
  return (
    <div className="ckSheet" role="status">
      <section>
        <strong>✓ {batch.saladName} logged</strong>
        <span>{batch.employeeName} · {time(batch.madeAt)}</span>
        {editing ? (
          <>
            <div className="ckChoices">
              {BATCH_SIZES.map((option) => <button type="button" key={option} className={size === option ? "ckYes" : ""} onClick={() => setSize(option)}>{option}</button>)}
            </div>
            <input value={notes} maxLength={200} placeholder="Note (optional)" onChange={(event) => setNotes(event.target.value)} />
            <div className="ckChoices">
              <button type="button" className="ckYes" disabled={busy} onClick={() => onSave(size, notes)}>Save</button>
              <button type="button" className="ckCancel" onClick={onClose}>Skip</button>
            </div>
          </>
        ) : (
          <div className="ckChoices">
            <button type="button" onClick={() => setEditing(true)}>Add size or note</button>
            <button type="button" disabled={busy} onClick={onUndo}>Undo</button>
            <button type="button" className="ckCancel" onClick={onClose}>OK</button>
          </div>
        )}
      </section>
    </div>
  );
}

function PinPad({ title, onPin, onCancel }: { title: string; onPin: (pin: string) => Promise<void>; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pin.length !== 4) return;
    setBusy(true);
    onPin(pin)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "PIN not recognized."))
      .finally(() => { setPin(""); setBusy(false); });
    // Submits once when the fourth digit is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);
  const digit = (value: string) => !busy && setPin((current) => (current.length < 4 ? current + value : current));
  return (
    <div className="ckModal" role="dialog" aria-modal="true" aria-label="Employee PIN">
      <section className="ckPin">
        <h2>{title}</h2>
        <p>Type your PIN</p>
        <div className="ckDots" aria-label={`${pin.length} of 4 digits`}>{[0, 1, 2, 3].map((index) => <i key={index} className={index < pin.length ? "on" : ""} />)}</div>
        <p className="ckPinError" role="alert">{error}</p>
        <div className="ckKeys">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((value) => <button type="button" key={value} disabled={busy} onClick={() => digit(value)}>{value}</button>)}
          <button type="button" aria-label="Backspace" disabled={busy || !pin} onClick={() => setPin((current) => current.slice(0, -1))}>←</button>
          <button type="button" disabled={busy} onClick={() => digit("0")}>0</button>
          <button type="button" className="ckCancel" onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
