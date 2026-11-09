"use client";
// Managers edit the store checklists and the deli salad buttons (POS Settings and the manager portal).
// Switching something off hides it from the screen and keeps its history; nothing here deletes.
import { useEffect, useState } from "react";
import { hourLabel } from "@/lib/store-checklist-rules";
import "./store-checklist-setup.css";

type Entry = { id: string; placeholder?: boolean; active: boolean };
type Item = Entry & { label: string };
type List = Entry & { name: string; opensAtHour: number; items: Item[] };
type Salad = Entry & { name: string };
type Setup = { lists: List[]; salads: Salad[] };
type Kind = "list" | "item" | "salad";

const HOURS = Array.from({ length: 24 }, (_, index) => index + 4);
const URL_SETUP = "/api/employee/manager-report/checklists/setup";

export default function StoreChecklistSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(URL_SETUP, { cache: "no-store" })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not load the checklists."); setSetup(body); })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  async function send(method: "PUT" | "PATCH", body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(URL_SETUP, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save.");
      setSetup(result);
      setMessage(done);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const move = (kind: Kind, id: string, direction: "up" | "down") => void send("PATCH", { kind, id, direction }, "Moved.");

  if (!setup) return <section className="ckSetup"><h2>Checklists &amp; deli salads</h2><p role={message ? "alert" : undefined}>{message || "Loading…"}</p></section>;
  return (
    <section className="ckSetup">
      <h2>Checklists &amp; deli salads</h2>
      <p className="ckSetupHint">
        What shows on the deli&apos;s checklist screen (<a href="/pos/checklists">/pos/checklists</a>). Lists start over at 4 AM each day.
        Items marked <em>placeholder</em> are examples to replace with your own wording. Switching one off hides it and keeps its history.
      </p>
      {message && <p className="ckSetupMessage" role="status">{message}</p>}
      <fieldset disabled={busy}>
        {setup.lists.map((list, index) => (
          <details key={list.id} className={list.active ? "" : "off"}>
            <summary>
              <strong>{list.name}</strong>
              <small>{list.items.filter((item) => item.active).length} items · opens from {hourLabel(list.opensAtHour)}{list.active ? "" : " · off"}</small>
            </summary>
            <ListEditor list={list} onSave={(change) => void send("PUT", { kind: "list", id: list.id, name: list.name, opensAtHour: list.opensAtHour, active: list.active, ...change }, "List saved.")} />
            <div className="ckSetupMoves">
              <button type="button" disabled={index === 0} onClick={() => move("list", list.id, "up")}>Move list up</button>
              <button type="button" disabled={index === setup.lists.length - 1} onClick={() => move("list", list.id, "down")}>Move list down</button>
            </div>
            <ol>
              {list.items.map((item, itemIndex) => (
                <Row key={item.id} text={item.label} entry={item} first={itemIndex === 0} last={itemIndex === list.items.length - 1}
                  onMove={(direction) => move("item", item.id, direction)}
                  onSave={(change) => void send("PUT", { kind: "item", id: item.id, name: item.label, active: item.active, ...change }, "Saved.")} />
              ))}
            </ol>
            <Adder placeholder="Add a job, e.g. Clean the slicer" onAdd={(name) => send("PUT", { kind: "item", checklistId: list.id, name }, "Added.")} />
          </details>
        ))}
        <Adder placeholder="New list, e.g. Shift change" onAdd={(name) => send("PUT", { kind: "list", name, opensAtHour: 12 }, "List added. Open it to add jobs.")} />

        <h3>Deli salads</h3>
        <p className="ckSetupHint">One button each on the screen. Staff tap it when they make a fresh batch.</p>
        <ol>
          {setup.salads.map((salad, index) => (
            <Row key={salad.id} text={salad.name} entry={salad} first={index === 0} last={index === setup.salads.length - 1}
              onMove={(direction) => move("salad", salad.id, direction)}
              onSave={(change) => void send("PUT", { kind: "salad", id: salad.id, name: salad.name, active: salad.active, ...change }, "Saved.")} />
          ))}
        </ol>
        <Adder placeholder="Add a salad, e.g. Egg salad" onAdd={(name) => send("PUT", { kind: "salad", name }, "Added.")} />
      </fieldset>
    </section>
  );
}

function ListEditor({ list, onSave }: { list: List; onSave: (change: { name?: string; opensAtHour?: number; active?: boolean }) => void }) {
  const [name, setName] = useState(list.name);
  useEffect(() => setName(list.name), [list.name]);
  return (
    <div className="ckSetupList">
      <label><span>List name</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>Screen opens on it from</span>
        <select value={list.opensAtHour} onChange={(event) => onSave({ opensAtHour: Number(event.target.value) })}>
          {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
        </select>
      </label>
      <button type="button" disabled={!name.trim() || name === list.name} onClick={() => onSave({ name })}>Rename</button>
      <button type="button" onClick={() => onSave({ active: !list.active })}>{list.active ? "Switch list off" : "Switch list on"}</button>
    </div>
  );
}

function Row({ text, entry, first, last, onMove, onSave }: { text: string; entry: Entry; first: boolean; last: boolean; onMove: (direction: "up" | "down") => void; onSave: (change: { name?: string; active?: boolean }) => void }) {
  const [value, setValue] = useState(text);
  useEffect(() => setValue(text), [text]);
  return (
    <li className={entry.active ? "" : "off"}>
      <input value={value} maxLength={80} aria-label="Wording" onChange={(event) => setValue(event.target.value)} />
      {entry.placeholder && <em>placeholder</em>}
      {!entry.active && <em>off</em>}
      <span>
        {value !== text && <button type="button" disabled={!value.trim()} onClick={() => onSave({ name: value })}>Save</button>}
        <button type="button" aria-label="Move up" disabled={first} onClick={() => onMove("up")}>↑</button>
        <button type="button" aria-label="Move down" disabled={last} onClick={() => onMove("down")}>↓</button>
        <button type="button" onClick={() => onSave({ active: !entry.active })}>{entry.active ? "Off" : "On"}</button>
      </span>
    </li>
  );
}

function Adder({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  return (
    <form className="ckSetupAdd" onSubmit={async (event) => { event.preventDefault(); if (value.trim() && (await onAdd(value))) setValue(""); }}>
      <input value={value} maxLength={80} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
      <button disabled={!value.trim()}>Add</button>
    </form>
  );
}
