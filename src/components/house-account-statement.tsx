import type { houseAccountStatement } from "@/lib/ordering-house-accounts";
import PrintButton from "./house-account-print-button";
import "./house-account-statement.css";

type Statement = NonNullable<Awaited<ReturnType<typeof houseAccountStatement>>>;

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const date = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
const time = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const calendar = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${day}T12:00:00Z`));

/** The full-page house-account statement (manager portal and POS): print it, or save it as a PDF from the print dialog. */
export default function HouseAccountStatement({ statement, backHref }: { statement: Statement; backHref: string }) {
  const { account, totals } = statement;
  return (
    <main className="haStatement">
      <nav className="haNoPrint"><a href={backHref}>‹ Back to {account.name}</a><PrintButton /></nav>
      <header>
        <div><h1>Corner Deli</h1><p>House account statement</p></div>
        <dl>
          <dt>Account</dt><dd><strong>{account.name}</strong>{account.phone && <><br />{account.phone}</>}{account.email && <><br />{account.email}</>}</dd>
          <dt>Period</dt><dd>{calendar(statement.from)} – {calendar(statement.to)}</dd>
          <dt>Balance due</dt><dd><strong>{money(totals.closingCents)}</strong></dd>
        </dl>
      </header>
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Order #</th><th>Details</th><th className="num">Charges</th><th className="num">Payments / credits</th><th className="num">Balance</th></tr></thead>
        <tbody>
          <tr className="opening"><td colSpan={6}>Previous balance</td><td className="num">{money(statement.openingCents)}</td></tr>
          {statement.rows.map((row, index) => <tr key={index}>
            <td>{date(row.at)}</td>
            <td>{time(row.at)}</td>
            <td>{row.orderNumber ? `#${row.orderNumber}` : ""}</td>
            <td>{row.type === "charge" ? row.items || "Order" : [row.label, row.method, row.reference && !row.orderNumber ? `#${row.reference}` : "", row.description].filter(Boolean).join(" · ")}</td>
            <td className="num">{row.deltaCents > 0 ? money(row.deltaCents) : ""}</td>
            <td className="num">{row.deltaCents < 0 ? money(-row.deltaCents) : ""}</td>
            <td className="num">{money(row.balanceCents)}</td>
          </tr>)}
          {statement.rows.length === 0 && <tr><td colSpan={7} className="empty">No activity in this period.</td></tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={4}>Totals</td><td className="num">{money(totals.chargesCents)}</td><td className="num">{money(totals.paymentsAndCreditsCents)}</td><td className="num"><strong>{money(totals.closingCents)}</strong></td></tr>
        </tfoot>
      </table>
      <p className="haFootnote">Questions about this statement? Call or stop by Corner Deli. Please pay the balance due at the counter.</p>
    </main>
  );
}
