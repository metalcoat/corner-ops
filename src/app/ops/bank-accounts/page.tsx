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

function requestedBusiness(): Business {
  if (typeof window === "undefined") return "Corner Deli";
  return new URLSearchParams(window.location.search).get("business") === "Tiki" ? "Tiki" : "Corner Deli";
}

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function BankAccountsPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>(requestedBusiness);
  const [data, setData] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  async function load(targetBusiness = business) {
    const response = await fetch(`/api/bank-accounts?business=${encodeURIComponent(targetBusiness)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json() as Payload;
    setData(payload);
    const next: Record<string, string[]> = {};
    for (const connection of payload.connections) {
      const activeIds = connection.accounts.filter((account) => account.active).map((account) => account.id);
      next[connection.id] = activeIds.length ? activeIds : connection.accounts[0] ? [connection.accounts[0].id] : [];
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

  function toggle(connectionId: string, accountId: string, checked: boolean) {
    setSelected((current) => {
      const values = new Set(current[connectionId] || []);
      if (checked) values.add(accountId);
      else values.delete(accountId);
      return { ...current, [connectionId]: Array.from(values) };
    });
  }

  async function save(connectionId: string) {
    const accountIds = selected[connectionId] || [];
    if (!accountIds.length) {
      setNotice("Keep at least one account active for each connected institution.");
      return;
    }
    setBusy(connectionId);
    setNotice("");
    try {
      const response = await fetch("/api/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-active-accounts", business, connectionId, accountIds }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice(`Saved ${accountIds.length} active feed${accountIds.length === 1 ? "" : "s"}. Selected bank and credit-card accounts will synchronize together.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Account selection failed.");
    } finally {
      setBusy("");
    }
  }

  if (!session) return <main className="bankAccountShell"><section className="bankAccountPanel"><h1>Loading bank and card accounts</h1></section></main>;
  if (!session.authenticated) return <main className="bankAccountShell"><section className="bankAccountPanel"><h1>Owner access required</h1><a className="bankPrimary" href="/">Return to sign-in</a></section></main>;

  return <main className="bankAccountShell">
    <header className="bankAccountHeader">
      <div>
        <p className="bankEyebrow">Plaid feed control</p>
        <h1>Choose bank and credit-card feeds</h1>
        <p>Each institution login may expose checking, savings, and several credit cards. Keep every account you want synchronized checked.</p>
      </div>
      <div className="bankBusinessSwitch">
        {(["Corner Deli", "Tiki"] as Business[]).map((name) => <button key={name} className={business === name ? "selected" : ""} onClick={() => setBusiness(name)}>{name}</button>)}
        <a className="bankPrimary" href={`/ops/integrations?connect=accounts&business=${encodeURIComponent(business)}`}>Connect another bank or card</a>
      </div>
    </header>

    {notice && <div className="bankNotice">{notice}</div>}

    {!data?.connections.length && <section className="bankAccountPanel emptyState">
      <h2>No linked bank or credit-card accounts</h2>
      <p>Connect each bank or card issuer through Plaid. You can repeat the connection process for as many institutions as the business uses.</p>
      <a className="bankPrimary" href={`/ops/integrations?connect=accounts&business=${encodeURIComponent(business)}`}>Connect an account</a>
    </section>}

    <div className="bankConnectionGrid">
      {(data?.connections || []).map((connection) => {
        const activeCount = selected[connection.id]?.length || 0;
        return <section className="bankAccountPanel" key={connection.id}>
          <div className="bankPanelHeader">
            <div>
              <p className="bankEyebrow">Connected institution</p>
              <h2>{connection.institutionName}</h2>
              <small>{activeCount} of {connection.accounts.length} account{connection.accounts.length === 1 ? "" : "s"} selected</small>
            </div>
            <span className="bankBadge">{connection.status}</span>
          </div>

          <div className="bankAccountList">
            {connection.accounts.map((account) => {
              const checked = (selected[connection.id] || []).includes(account.id);
              const isCard = account.type === "credit";
              return <label className={`bankAccountChoice ${checked ? "chosen" : ""}`} key={account.id}>
                <input
                  type="checkbox"
                  name={`connection-${connection.id}`}
                  value={account.id}
                  checked={checked}
                  onChange={(event) => toggle(connection.id, account.id, event.target.checked)}
                />
                <span className="bankRadio" />
                <span className="bankAccountDetails">
                  <strong>{account.officialName || account.name}</strong>
                  <small>{isCard ? "Credit card" : account.type || "Bank account"}{account.subtype ? ` · ${account.subtype}` : ""}{account.mask ? ` · ending ${account.mask}` : ""}</small>
                </span>
                <span className="bankBalance">
                  <strong>{money(account.currentBalance)}</strong>
                  <small>{isCard ? "Current amount owed" : account.availableBalance === null ? "" : `${money(account.availableBalance)} available`}</small>
                </span>
              </label>;
            })}
          </div>

          <button className="bankPrimary" disabled={busy === connection.id || activeCount === 0} onClick={() => void save(connection.id)}>
            {busy === connection.id ? "Saving…" : `Save ${activeCount} active feed${activeCount === 1 ? "" : "s"}`}
          </button>
        </section>;
      })}
    </div>
  </main>;
}