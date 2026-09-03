import "../control-center.css";
import "./settings.css";

const settings = [
  {
    title: "Bank accounts",
    description: "Connect, label, and review checking, savings, and credit-card accounts.",
    href: "/ops/bank-accounts",
    action: "Manage accounts",
  },
  {
    title: "Integrations & scheduler",
    description: "Manage Plaid, bank imports, and scheduled native operations.",
    href: "/ops/integrations",
    action: "Open integrations",
  },
  {
    title: "Cards & receipt setup",
    description: "Review card connections, OCR status, receipt folders, and transaction matching.",
    href: "/ops/expense-control",
    action: "Open cards & receipts",
  },
];

export default function SettingsPage() {
  return <main className="controlPage">
    <header className="controlHeader">
      <div><p className="eyebrow">Configuration</p><h1>Settings</h1><p>Account connections and administrative tools live here instead of occupying the daily operations menu like needy houseplants.</p></div>
      <div className="controlActions"><a href="/ops">Operations</a></div>
    </header>
    <section className="settingsGrid">{settings.map((item) => <article className="controlCard settingsCard" key={item.href}><div><p className="eyebrow">System setting</p><h2>{item.title}</h2><p>{item.description}</p></div><a href={item.href}>{item.action}</a></article>)}</section>
  </main>;
}
