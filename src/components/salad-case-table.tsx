"use client";
// "Salads in the case": when the batch now in the case was made, how old it is and who made it, with the fryers'
// last oil change underneath. Shown on the checklist screen (every tab) and at the top of the manager's Checklists
// history. With "good for N days" set on a salad, its row turns amber on the last good day and red after.
import { ageLabel, madeLabel, saladFreshness } from "@/lib/store-checklist-rules";
import "./salad-case-table.css";

export type CaseSalad = { name: string; at: string | null; by: string | null; goodForDays: number | null };
export type CaseFryer = { name: string; at: string | null; by: string | null };
const NOTE = { last: "Last day", past: "Past its days" } as const;

export default function SaladCaseTable({ salads, fryers = [], now }: { salads: CaseSalad[]; fryers?: CaseFryer[]; now: number }) {
  const at = new Date(now);
  const first = (name: string | null) => (name ? name.split(/\s+/)[0] : "—");
  return <>
    {salads.length ? <table className="saladCase">
      <thead><tr><th>Salad</th><th>Made</th><th>Age</th><th>By</th></tr></thead>
      <tbody>
        {salads.map((salad) => {
          const fresh = salad.at ? saladFreshness(salad.at, salad.goodForDays, at) : null;
          return (
            <tr key={salad.name} className={fresh && fresh !== "ok" ? fresh : undefined}>
              <th scope="row">{salad.name}{fresh && fresh !== "ok" && <small>{NOTE[fresh]}</small>}</th>
              <td>{salad.at ? madeLabel(salad.at) : "—"}</td>
              <td>{salad.at ? ageLabel(salad.at, at) : "—"}</td>
              <td>{first(salad.by)}</td>
            </tr>
          );
        })}
      </tbody>
    </table> : <p className="saladCaseEmpty">No salads set up.</p>}
    {fryers.length > 0 && <table className="saladCase fryers">
      <thead><tr><th>Fryer oil</th><th>Changed</th><th>Age</th><th>By</th></tr></thead>
      <tbody>
        {fryers.map((fryer) => <tr key={fryer.name}>
          <th scope="row">{fryer.name}</th>
          <td>{fryer.at ? madeLabel(fryer.at) : "—"}</td>
          <td>{fryer.at ? ageLabel(fryer.at, at) : "—"}</td>
          <td>{first(fryer.by)}</td>
        </tr>)}
      </tbody>
    </table>}
  </>;
}
