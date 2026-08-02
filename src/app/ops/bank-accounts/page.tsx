"use client";

import { useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "./bank-accounts.css";

type BankAccount = {
  id: string;
  externalAccountId: string;
  name: string;
  officialName: string;
  mask: string;
  type: string;
  subtype: string;
  currentBalance: number | null;
  availableBalance: number | null;
  active: boolean;
};

type Connection = {
  id: string;
  institutionName: string;
  status: string;
  accounts: BankAccount[];
};

type Payload = {
  business: Business;
  connections: Connection[];
};

function money(value: number | null) {
  if (value === null) return "Balance unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function BankAccountsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [data, setData] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  async function load(targetBusiness = business) {
    const response = await fetch(`/api/bank-accounts?business=${encodeURIComponent(targetBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as Payload;
    setData(payload);
    const next: Record<string, string> = {};
    for (const connection of payload.connections) {
      next[connection.id] = connection.accounts.find((account) => account.active)?.id || connection.accounts[0]?.id || "";
    }
    setSelected(next);
  }

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false, configured: false, missing: ["Unable to reach server"] }));
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.authenticated, business]);

  async function save(connectionId: string) {
    const accountId = selected[connectionId];
    if (!accountId) return;
    setBusy(connectionId);
    setNotice("");
    try {
      const response = await fetch("/api/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select-account", business, connectionId, accountId }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice("Account selection saved. Only the selected account will appear in the active bank feed.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Account selection failed.");
    } finally {
      setBusy("");
    }
  }

  if (!session) return <main className="bankAccountShell"><section className="bankAccountPanel"><h1>Loading bank accounts</h1></section></main>;
  if (!session.authenticated) return <main className="bankAccountShell"><section className="bankAccountPanel"><h1>Owner access required</h1><a className="bankPrimary" href="/">Return to sign-in</a></section></main>;

  return <main className="bankAccountShell">
    <header className="bankAccountHeader">
      <div>
        <p className="bankEyebrow">Plaid account control</p>
        <h1>Choose the business bank account</h1>
        <p>Each bank login can expose several accounts. Select the one Corner Ops should synchronize and ignore the rest.</p>
      </div>
      <div className="bankBusinessSwitch">
        {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
      </div>
    </header>

    {notice && <div className="bankNotice">{notice}</div>}

    {!data?.connections.length && <section className="bankAccountPanel emptyState">
      <h2>No linked bank accounts</h2>
      <p>Connect {business === "Corner Deli" ? "SEACOMM" : "NBT Bank"} from Scheduler & Integrations first.</p>
      <a className="bankPrimary" href="/ops/integrations">Open integrations</a>
    </section>}

    <div className="bankConnectionGrid">
      {(data?.connections || []).map((connection) => <section className="bankAccountPanel" key={connection.id}>
        <div className="bankPanelHeader">
          <div>
            <p className="bankEyebrow">Connected institution</p>
            <h2>{connection.institutionName}</h2>
          </div>
          <span className="bankBadge">{connection.status}</span>
        </div>

        <div className="bankAccountList">
          {connection.accounts.map((account) => <label className={`bankAccountChoice ${selected[connection.id] === account.id ? "chosen" : ""}`} key={account.id}>
            <input
              type="radio"
              name={`connection-${connection.id}`}
              value={account.id}
              checked={selected[connection.id] === account.id}
              onChange={() => setSelected((current) => ({ ...current, [connection.id]: account.id }))}
            />
            <span className="bankRadio" />
            <span className="bankAccountDetails">
              <strong>{account.officialName || account.name}</strong>
              <small>{account.type} · {account.subtype}{account.mask ? ` · ending ${account.mask}` : ""}</small>
            </span>
            <span className="bankBalance">
              <strong>{money(account.currentBalance)}</strong>
              <small>{account.availableBalance === null ? "" : `${money(account.availableBalance)} available`}</small>
            </span>
          </label>)}
        </div>

        <button className="bankPrimary" disabled={busy === connection.id || !selected[connection.id]} onClick={() => void save(connection.id)}>
          {busy === connection.id ? "Saving…" : `Use selected account for ${business}`}
        </button>
      </section>)}
    </div>
  </main>;
}
