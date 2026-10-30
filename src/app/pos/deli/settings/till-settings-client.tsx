"use client";

import { useCallback, useEffect, useState } from "react";
import { DENOMINATIONS, type DenominationKey, type FloatItem, type TillSettings } from "@/lib/till-reset-rules";

type Till = { id: string; name: string; terminalKey: string; stations: string; label: string; configured: boolean; resetCents: number; settings: TillSettings };
// Form rows hold dollars as typed; a row is used when "on".
type Row = { on: boolean; target: string; min: string; max: string };
type Form = { float: Record<string, Row>; bagOn: boolean; bag: Record<string, Row> };

const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const dollars = (c: number) => (c / 100).toFixed(2);
const toCents = (value: string) => Math.round(Number(value || 0) * 100);
const blank: Row = { on: false, target: "0.00", min: "0.00", max: "0.00" };

function rows(items: FloatItem[] | null): Record<string, Row> {
  const result: Record<string, Row> = Object.fromEntries(DENOMINATIONS.map(d => [d.key, { ...blank }]));
  for (const item of items || []) result[item.key] = { on: true, target: dollars(item.targetCents), min: dollars(item.minCents), max: dollars(item.maxCents) };
  return result;
}
const toForm = (settings: TillSettings): Form => ({ float: rows(settings.float), bagOn: Boolean(settings.bag), bag: rows(settings.bag) });
const items = (form: Record<string, Row>): FloatItem[] => DENOMINATIONS.filter(d => form[d.key].on).map(d => ({ key: d.key as DenominationKey, targetCents: toCents(form[d.key].target), minCents: toCents(form[d.key].min), maxCents: toCents(form[d.key].max) }));
const sum = (form: Record<string, Row>) => items(form).reduce((total, item) => total + item.targetCents, 0);

function PlanTable({ title, form, onChange }: { title: string; form: Record<string, Row>; onChange: (key: string, row: Row) => void }) {
  return <article><h3>{title} — {money(sum(form))}</h3><p className="posSettingsHint">Tick the bills and coins this can hold. Target is what it should have; the POS never goes under the minimum or over the limit unless the drawer can&apos;t make the amount any other way (that gets flagged in the closeout email).</p>
    <table className="tillPlanTable"><thead><tr><th>Use</th><th>Bill / coin</th><th>Target $</th><th>Minimum $</th><th>Limit $</th></tr></thead><tbody>{DENOMINATIONS.map(d => { const row = form[d.key]; return <tr key={d.key} className={row.on ? "" : "off"}><td><input type="checkbox" checked={row.on} aria-label={`Use ${d.label}`} onChange={e => onChange(d.key, { ...row, on: e.target.checked })} /></td><td>{d.label}</td>{(["target", "min", "max"] as const).map(field => <td key={field}><input type="number" inputMode="decimal" min="0" step={d.cents / 100} disabled={!row.on} value={row[field]} aria-label={`${d.label} ${field}`} onChange={e => onChange(d.key, { ...row, [field]: e.target.value })} /></td>)}</tr>; })}</tbody></table></article>;
}

export default function TillSettingsClient() {
  const [tills, setTills] = useState<Till[]>([]), [forms, setForms] = useState<Record<string, Form>>({}), [message, setMessage] = useState(""), [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/ordering/register/tills", { cache: "no-store" }), body = await response.json();
    if (!response.ok) throw new Error(body.error || "Tills unavailable.");
    setTills(body.tills); setForms(Object.fromEntries(body.tills.map((till: Till) => [till.id, toForm(till.settings)])));
  }, []);
  useEffect(() => { void load().catch(error => setMessage(error.message)); }, [load]);
  async function save(till: Till, reset = false) {
    const form = forms[till.id]; setBusy(till.id); setMessage("");
    try {
      const response = await fetch("/api/ordering/register/tills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ terminalId: till.id, reset, settings: { float: items(form.float), bag: form.bagOn ? items(form.bag) : null } }) }), body = await response.json();
      if (!response.ok) throw new Error(body.error || "Till settings could not be saved.");
      setMessage(`${till.name}: ${reset ? "back to the defaults" : "saved"}. It now resets to ${money(body.resetCents)}${body.settings.bag ? ` with a ${money(body.settings.bag.reduce((t: number, i: FloatItem) => t + i.targetCents, 0))} change bag` : ""}.`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Till settings could not be saved."); } finally { setBusy(""); }
  }
  async function retire(till: Till) {
    if (!window.confirm(`Retire ${till.name}? It stops showing here; its history is kept. Only for a till no station uses.`)) return;
    setBusy(till.id); setMessage("");
    try {
      const response = await fetch("/api/ordering/register/tills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retire", terminalId: till.id }) }), body = await response.json();
      if (!response.ok) throw new Error(body.error || "The till could not be retired.");
      setMessage(`${till.name} retired.`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The till could not be retired."); } finally { setBusy(""); }
  }
  const change = (id: string, part: "float" | "bag", key: string, row: Row) => setForms(current => ({ ...current, [id]: { ...current[id], [part]: { ...current[id][part], [key]: row } } }));
  return <section className="posSettingsCard tillSettings"><p className="posDevEyebrow">Register</p><h2>Tills</h2><p>What each till is reset to at closeout, and the change bag if it has one. Staff count every bill and coin; the POS then tells them exactly what to leave in the till and the bag, and emails the owner the summary with anything that falls short.</p>
    {message && <p role="status" className="posSettingsHint">{message}</p>}
    {tills.map(till => { const form = forms[till.id]; if (!form) return null; return <article key={till.id}><h3>{till.name} <small>({till.label}{till.stations ? ` · ${till.stations}` : " · no station uses it"}{till.configured ? "" : " · defaults"})</small></h3>
      <PlanTable title="Till float (left in the drawer)" form={form.float} onChange={(key, row) => change(till.id, "float", key, row)} />
      <label className="tillBagToggle"><input type="checkbox" checked={form.bagOn} onChange={e => setForms(current => ({ ...current, [till.id]: { ...current[till.id], bagOn: e.target.checked } }))} /> This till has a separate change bag</label>
      {form.bagOn && <PlanTable title="Change bag" form={form.bag} onChange={(key, row) => change(till.id, "bag", key, row)} />}
      <div className="posTools"><button disabled={busy === till.id} onClick={() => void save(till)}>SAVE {till.name.toUpperCase()}</button>{till.configured && <button className="danger" disabled={busy === till.id} onClick={() => void save(till, true)}>USE DEFAULTS</button>}{!till.stations && <button className="danger" disabled={busy === till.id} onClick={() => void retire(till)}>RETIRE THIS TILL</button>}</div></article>; })}
    {!tills.length && !message && <p>Loading tills…</p>}
  </section>;
}
