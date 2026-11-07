"use client";

import { useEffect, useState } from "react";

// Store rules for the AI phone line (Chris, 2026-11-07): wording and menu habits a manager can change without a
// deploy. The next call uses them; the ordering system still checks every item and price.

type Rule = { id: string; position: number; title: string; rule: string; active: boolean; updatedAt: string; updatedBy: string };
type Draft = { id?: string; title: string; rule: string; active: boolean };
type HistoryRow = { ruleId: string; action: "create" | "update" | "delete"; before: Rule | null; after: Rule | null; actorId: string; at: string };
type Payload = { rules: Rule[]; history: HistoryRow[]; limits: { rules: number; ruleChars: number; titleChars: number; totalChars: number } };

const EXAMPLES = [
  "Hamburger Steak: ask peppers, mushrooms, or onions first, then the salad dressing.",
  "“Chicken nuggets” is Chicken Nuggets (6, 10 or 20 piece), never Popcorn Chicken.",
  "Never offer a drink on orders over $40.",
];

export default function AiPhoneRulesClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<Draft>({ title: "", rule: "", active: true });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await fetch("/api/ordering/settings/ai-phone/rules", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Phone rules are unavailable.");
    setData(body);
    setDrafts(Object.fromEntries((body.rules as Rule[]).map((rule) => [rule.id, { id: rule.id, title: rule.title, rule: rule.rule, active: rule.active }])));
  }
  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : "Phone rules are unavailable."));
  }, []);

  async function send(method: "PUT" | "DELETE", body?: Draft, id?: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/ordering/settings/ai-phone/rules${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the rule.");
      await load();
      setMessage(method === "DELETE" ? "Rule deleted. Calls that start now won't use it." : "Saved. Calls that start now use it.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the rule.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data)
    return (
      <section className="posSettingsCard">
        <h2>AI phone rules</h2>
        <p role={message ? "alert" : undefined}>{message || "Loading…"}</p>
      </section>
    );

  const activeChars = data.rules.filter((rule) => rule.active).reduce((sum, rule) => sum + rule.title.length + rule.rule.length, 0);
  const field = (draft: Draft, change: (next: Draft) => void) => (
    <>
      <label>
        <span>Name</span>
        <input value={draft.title} maxLength={data.limits.titleChars} placeholder="Hamburger Steak" onChange={(event) => change({ ...draft, title: event.target.value })} />
      </label>
      <label>
        <span>Rule ({draft.rule.length}/{data.limits.ruleChars})</span>
        <textarea rows={3} value={draft.rule} maxLength={data.limits.ruleChars} onChange={(event) => change({ ...draft, rule: event.target.value })} />
      </label>
      <label>
        <span>On</span>
        <input type="checkbox" checked={draft.active} onChange={(event) => change({ ...draft, active: event.target.checked })} />
      </label>
    </>
  );

  return (
    <section className="posSettingsCard">
      <h2>AI phone rules</h2>
      <p>
        Tell the phone AI how this store takes orders, in plain words. Calls that start after you save use the new
        rules; no update needed. Prices, menu checks, card payments and transfers to the store still work the same.
      </p>
      <p>
        <strong>{data.rules.filter((rule) => rule.active).length}</strong> on · {activeChars}/{data.limits.totalChars} characters
        (the AI re-reads these every turn, so shorter is cheaper)
      </p>
      {data.rules.map((rule) => {
        const draft = drafts[rule.id];
        if (!draft) return null;
        const changed = draft.title !== rule.title || draft.rule !== rule.rule || draft.active !== rule.active;
        return (
          <fieldset key={rule.id} disabled={busy}>
            {field(draft, (next) => setDrafts((current) => ({ ...current, [rule.id]: next })))}
            <button type="button" disabled={!changed || !draft.rule.trim()} onClick={() => void send("PUT", draft)}>
              Save
            </button>{" "}
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete the rule “${rule.title || rule.rule.slice(0, 40)}”?`)) void send("DELETE", undefined, rule.id);
              }}
            >
              Delete
            </button>
          </fieldset>
        );
      })}
      <fieldset disabled={busy || data.rules.length >= data.limits.rules}>
        <legend>Add a rule</legend>
        {field(adding, setAdding)}
        <p>Examples: {EXAMPLES.join(" · ")}</p>
        <button
          type="button"
          disabled={!adding.rule.trim()}
          onClick={async () => {
            if (await send("PUT", adding)) setAdding({ title: "", rule: "", active: true });
          }}
        >
          Add rule
        </button>
      </fieldset>
      {data.history.length > 0 && (
        <details>
          <summary>Recent changes</summary>
          <ul>
            {data.history.slice(0, 15).map((row, index) => {
              const shown = row.after || row.before;
              const putBack = row.before;
              return (
                <li key={`${row.ruleId}-${row.at}-${index}`}>
                  {new Date(row.at).toLocaleString()} · {row.action === "create" ? "added" : row.action === "update" ? "changed" : "deleted"} “
                  {shown?.title || shown?.rule.slice(0, 50)}”
                  {putBack && (
                    <>
                      {" "}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void send("PUT", {
                            id: row.action === "delete" ? undefined : row.ruleId,
                            title: putBack.title,
                            rule: putBack.rule,
                            active: putBack.active,
                          })
                        }
                      >
                        Put back the earlier version
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <p role={message ? "status" : undefined}>{message}</p>
    </section>
  );
}
