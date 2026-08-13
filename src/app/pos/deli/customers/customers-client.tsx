"use client";

import { useCallback, useEffect, useState } from "react";
import PosPinGate, { type PosSessionView } from "../../pos-pin-gate";

type Phone = { id: string; normalized_phone: string; display_phone: string; label: string; is_primary: boolean; last_used_at: string | null };
type Address = { id: string; label: string; line1: string; line2: string; city: string; state: string; postal_code: string; is_primary: boolean; last_used_at: string | null };
type Customer = {
  id: string; first_name: string; last_name: string; display_name: string; normalized_phone: string;
  display_phone: string; email: string; notes: string; last_order_at: string | null; phones: Phone[]; addresses: Address[];
};
type DuplicateMatch = { customer_id: string; display_name: string; display_phone: string };

export default function CustomersClient() {
  const [session, setSession] = useState<PosSessionView | null>(null);
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [phoneLabel, setPhoneLabel] = useState("Mobile");
  const [phonePrimary, setPhonePrimary] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  const [address, setAddress] = useState({ label: "Home", line1: "", line2: "", city: "Ogdensburg", state: "NY", postalCode: "", isPrimary: false });
  const [message, setMessage] = useState("");
  const [merge, setMerge] = useState<string[]>([]);

  useEffect(() => { fetch("/api/pos/session").then((response) => response.json()).then(setSession); }, []);
  const load = useCallback(async () => {
    if (!session?.authenticated) return;
    const response = await fetch(`/api/ordering/customers?q=${encodeURIComponent(query)}`);
    const body = await response.json() as { customers?: Customer[] };
    setCustomers(body.customers || []);
  }, [query, session?.authenticated]);
  useEffect(() => { const timeout = setTimeout(() => void load(), 150); return () => clearTimeout(timeout); }, [load]);
  useEffect(() => {
    const locked = () => setSession({ authenticated: false });
    window.addEventListener("corner-ops-pos-locked", locked);
    return () => window.removeEventListener("corner-ops-pos-locked", locked);
  }, []);

  const selected = customers.find((customer) => customer.id === selectedId) || null;

  async function create() {
    const response = await fetch("/api/ordering/customers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ firstName: first, lastName: last, phone }) });
    const body = await response.json() as { customer?: Customer; error?: string };
    if (response.status === 409) {
      setMessage(`Existing customer found: ${body.customer?.display_name}. Select that record instead.`);
      setQuery(phone);
    } else if (response.ok) {
      setMessage("Customer created."); setFirst(""); setLast(""); setPhone(""); await load();
    } else setMessage(body.error || "Could not create customer.");
  }

  async function addPhone(allowShared = false) {
    if (!selected) return;
    const response = await fetch(`/api/ordering/customers/${selected.id}/phones`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: newPhone, label: phoneLabel, isPrimary: phonePrimary, allowShared }) });
    const body = await response.json() as { duplicate?: boolean; matches?: DuplicateMatch[]; error?: string };
    if (response.status === 409) {
      setDuplicateMatches(body.matches || []);
      setMessage("That number belongs to another active customer. Use that customer, or explicitly share the number.");
      return;
    }
    if (!response.ok) { setMessage(body.error || "Could not add phone."); return; }
    setDuplicateMatches([]); setNewPhone(""); setPhonePrimary(false); setMessage("Phone added."); await load();
  }

  async function addAddress() {
    if (!selected) return;
    const response = await fetch(`/api/ordering/customers/${selected.id}/addresses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(address) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { setMessage(body.error || "Could not add address."); return; }
    setAddress({ label: "Home", line1: "", line2: "", city: "Ogdensburg", state: "NY", postalCode: "", isPrimary: false });
    setMessage("Address added."); await load();
  }

  async function doMerge() {
    if (merge.length !== 2) return;
    const response = await fetch("/api/ordering/customers/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ survivorId: merge[0], mergedId: merge[1] }) });
    const body = await response.json() as { error?: string };
    setMessage(response.ok ? "Customers merged; phones, addresses, order links, and historical snapshots were preserved." : body.error || "Merge failed.");
    setMerge([]); setSelectedId(""); await load();
  }

  function useForOrder(customer: Customer) {
    window.dispatchEvent(new CustomEvent("corner-ops-pos-customer-selected", { detail: customer }));
    setMessage(`${customer.display_name} attached to the current order.`);
  }

  if (!session) return <main className="ocPage">Loading customers…</main>;
  if (!session.authenticated) return <PosPinGate onAuthenticated={(next) => setSession({ authenticated: true, session: next })} />;

  return <main className="ocPage customerWorkspace">
    <header><div><h1>Customers</h1><p>Find callers, manage contact choices, and attach a customer to the current order.</p></div></header>
    <div className="ocTools"><input className="search" autoFocus type="search" placeholder="Name or phone" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {message && <p className="customerMessage" role="status">{message}</p>}
    <div className="customerColumns">
      <section className="customerList">
        <details className="customerCreate">
          <summary>+ NEW CUSTOMER</summary>
          <div className="customerFormRow">
            <input placeholder="First name" value={first} onChange={(event) => setFirst(event.target.value)} />
            <input placeholder="Last name" value={last} onChange={(event) => setLast(event.target.value)} />
            <input placeholder="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
            <button onClick={() => void create()}>CREATE / FIND</button>
          </div>
        </details>
        <h2>ACTIVE CUSTOMERS <span>{customers.length}</span></h2>
        {customers.map((customer) => <article className={`customerRow ${selectedId === customer.id ? "selected" : ""}`} key={customer.id}>
          <button className="customerSelect" onClick={() => setSelectedId(customer.id)}>
            <b>{customer.display_name}</b><span>{customer.phones.map((item) => item.display_phone).join(" · ") || "No phone"}</span>
            <small>{customer.addresses.length} address{customer.addresses.length === 1 ? "" : "es"} · {customer.last_order_at ? `Last order ${new Date(customer.last_order_at).toLocaleDateString()}` : "No orders"}</small>
          </button>
          <label><input type="checkbox" aria-label={`Select ${customer.display_name} for merge`} checked={merge.includes(customer.id)} onChange={(event) => setMerge((value) => event.target.checked ? [...value, customer.id].slice(-2) : value.filter((id) => id !== customer.id))} /> Merge</label>
        </article>)}
        {merge.length === 2 && <button className="mergeButton" onClick={() => void doMerge()}>MERGE SECOND CUSTOMER INTO FIRST</button>}
      </section>

      <section className="customerDetail" aria-live="polite">
        {!selected && <div className="customerEmpty">Select a customer to see phones, addresses, and order history.</div>}
        {selected && <>
          <div className="customerDetailHead"><div><h2>{selected.display_name}</h2><small>{selected.email || "No email"}</small></div><button onClick={() => useForOrder(selected)}>USE FOR CURRENT ORDER</button></div>
          <h3>PHONES</h3>
          <div className="customerContactList">{selected.phones.map((item) => <div key={item.id}><b>{item.label || "Other"}</b><span>{item.display_phone}</span>{item.is_primary && <em>Primary</em>}</div>)}</div>
          <div className="customerFormRow"><select value={phoneLabel} onChange={(event) => setPhoneLabel(event.target.value)}><option>Mobile</option><option>Home</option><option>Work</option><option>Other</option></select><input placeholder="Phone number" value={newPhone} onChange={(event) => { setNewPhone(event.target.value); setDuplicateMatches([]); }} /><label><input type="checkbox" checked={phonePrimary} onChange={(event) => setPhonePrimary(event.target.checked)} /> Primary</label><button onClick={() => void addPhone()}>+ PHONE</button></div>
          {duplicateMatches.length > 0 && <div className="duplicateWarning"><strong>EXISTING CUSTOMER</strong>{duplicateMatches.map((match) => <button key={match.customer_id} onClick={() => { setQuery(match.display_phone); setSelectedId(match.customer_id); }}>{match.display_name} · {match.display_phone}<small>USE CUSTOMER</small></button>)}<button className="sharedPhone" onClick={() => void addPhone(true)}>SHARE NUMBER ANYWAY</button></div>}

          <h3>ADDRESSES</h3>
          <div className="customerContactList">{selected.addresses.map((item) => <div key={item.id}><b>{item.label || "Other"}</b><span>{item.line1}{item.line2 ? `, ${item.line2}` : ""}<small>{item.city}, {item.state} {item.postal_code}</small></span>{item.is_primary && <em>Primary</em>}</div>)}</div>
          <div className="customerAddressForm"><select value={address.label} onChange={(event) => setAddress((value) => ({ ...value, label: event.target.value }))}><option>Home</option><option>Work</option><option>Other</option></select><input placeholder="Street address" value={address.line1} onChange={(event) => setAddress((value) => ({ ...value, line1: event.target.value }))} /><input placeholder="Apt / unit" value={address.line2} onChange={(event) => setAddress((value) => ({ ...value, line2: event.target.value }))} /><input placeholder="City" value={address.city} onChange={(event) => setAddress((value) => ({ ...value, city: event.target.value }))} /><input aria-label="State" value={address.state} onChange={(event) => setAddress((value) => ({ ...value, state: event.target.value }))} /><input placeholder="ZIP" value={address.postalCode} onChange={(event) => setAddress((value) => ({ ...value, postalCode: event.target.value }))} /><label><input type="checkbox" checked={address.isPrimary} onChange={(event) => setAddress((value) => ({ ...value, isPrimary: event.target.checked }))} /> Primary</label><button onClick={() => void addAddress()}>+ ADDRESS</button></div>
          <h3>ORDER HISTORY</h3><p className="customerHistory">{selected.last_order_at ? `Last order ${new Date(selected.last_order_at).toLocaleString()}` : "No orders yet."}</p>
        </>}
      </section>
    </div>
  </main>;
}
