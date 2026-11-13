"use client";

import { useEffect, useState } from "react";
import { employeeDrinkPriceCents } from "@/lib/ordering-employee-drink-rules";

type Size = { key: string; label: string; costCents: number; depositCents: number; priceCents: number; updatedBy: string; items: Array<{ itemId: string }> };
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function EmployeeDrinkSettingsClient() {
  const [sizes, setSizes] = useState<Size[]>([]), [rate, setRate] = useState(0), [draft, setDraft] = useState<Record<string, { cost: string; deposit: string }>>({}), [message, setMessage] = useState("");
  function apply(body: { sizes: Size[]; taxRateBps: number }) {
    setSizes(body.sizes); setRate(body.taxRateBps);
    setDraft(Object.fromEntries(body.sizes.map((size) => [size.key, { cost: (size.costCents / 100).toFixed(2), deposit: (size.depositCents / 100).toFixed(2) }])));
  }
  useEffect(() => {
    void fetch("/api/ordering/employee-drinks", { cache: "no-store" }).then((response) => response.json()).then((body) => { if (!body.sizes) throw new Error(body.error || "Could not load."); apply(body); }).catch((error) => setMessage(error.message));
  }, []);
  const cents = (value: string) => Math.round(Number(value || 0) * 100);
  async function save() {
    setMessage("");
    const response = await fetch("/api/ordering/employee-drinks", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sizes: sizes.map((size) => ({ key: size.key, costCents: cents(draft[size.key]?.cost), depositCents: cents(draft[size.key]?.deposit) })) }) }), body = await response.json();
    if (response.ok) { apply(body); setMessage("Saved. New employee prices apply right away."); } else setMessage(body.error || "Could not save.");
  }
  return <section className="posSettingsCard"><h2>Employee drinks at cost</h2>
    <p className="posSettingsHint">Employees pay cost plus bottle deposit plus sales tax ({(rate / 100).toFixed(2)}%), rounded up to the next $0.25. Update the cost when the supplier price changes; MEAL stays separate (drinks aren&apos;t part of the meal). On the POS, a signed-in employee taps DRINK.</p>
    {sizes.map((size) => {
      const row = draft[size.key] || { cost: "0", deposit: "0" };
      return <div key={size.key} className="posSettingsGrid">
        <strong>{size.label} <small>({size.items.length} drinks)</small></strong>
        <label>Cost<input inputMode="decimal" value={row.cost} onChange={(event) => setDraft((current) => ({ ...current, [size.key]: { ...row, cost: event.target.value } }))} /></label>
        <label>Deposit<input inputMode="decimal" value={row.deposit} onChange={(event) => setDraft((current) => ({ ...current, [size.key]: { ...row, deposit: event.target.value } }))} /></label>
        <strong>Employee price: {money(employeeDrinkPriceCents(cents(row.cost), cents(row.deposit), rate))}</strong>
      </div>;
    })}
    <div className="posTools"><button type="button" onClick={() => void save()}>SAVE DRINK COSTS</button></div>
    {message && <p role="status" className="posSettingsHint">{message}</p>}
  </section>;
}
