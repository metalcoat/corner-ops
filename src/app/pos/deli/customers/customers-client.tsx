"use client";

import { useCallback, useEffect, useState } from "react";
import PosPinGate, { type PosSessionView } from "../../pos-pin-gate";

type Phone = {
  id: string;
  normalized_phone: string;
  display_phone: string;
  label: string;
  is_primary: boolean;
  last_used_at: string | null;
};
type Email = {
  id: string;
  display_email: string;
  label: string;
  is_primary: boolean;
};
type Address = {
  id: string;
  label: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  is_primary: boolean;
  last_used_at: string | null;
};
type Customer = {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  normalized_phone: string;
  display_phone: string;
  email: string;
  notes: string;
  last_order_at: string | null;
  phones: Phone[];
  emails: Email[];
  addresses: Address[];
};
type ImportPreview = {
  sourceRows: number;
  customerGroups: number;
  duplicatesCollapsed: number;
  phones: number;
  emails: number;
  addresses: number;
  sample: Array<{
    name: string;
    rows: number;
    phones: string[];
    emails: string[];
    addresses: string[];
  }>;
};
type DuplicateMatch = {
  customer_id: string;
  display_name: string;
  display_phone: string;
};
type LoyaltyProgram = {
  programId: string;
  name: string;
  progress: number;
  quantityRequired: number;
  rewardsAvailable: number;
};
type LoyaltyEvent = {
  id: string;
  entry_type: string;
  delta_units: number;
  reason: string;
  created_by: string;
  display_number: string | null;
  created_at: string;
};

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
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>(
    [],
  );
  const [address, setAddress] = useState({
    label: "Home",
    line1: "",
    line2: "",
    city: "Ogdensburg",
    state: "NY",
    postalCode: "",
    isPrimary: false,
  });
  const [message, setMessage] = useState("");
  const [editName, setEditName] = useState({ firstName: "", lastName: "" });
  const [editNameBusy, setEditNameBusy] = useState(false);
  const [merge, setMerge] = useState<string[]>([]);
  const [importFile, setImportFile] = useState<File | null>(null),
    [importPreview, setImportPreview] = useState<ImportPreview | null>(null),
    [importBusy, setImportBusy] = useState(false);
  const [loyalty, setLoyalty] = useState<LoyaltyProgram[]>([]),
    [loyaltyHistory, setLoyaltyHistory] = useState<LoyaltyEvent[]>([]),
    [adjustment, setAdjustment] = useState({
      programId: "",
      deltaUnits: 1,
      reason: "",
    });

  useEffect(() => {
    fetch("/api/pos/session")
      .then((response) => response.json())
      .then(setSession);
  }, []);
  const load = useCallback(async () => {
    if (!session?.authenticated) return;
    const response = await fetch(
      `/api/ordering/customers?q=${encodeURIComponent(query)}`,
    );
    const body = (await response.json()) as { customers?: Customer[] };
    setCustomers(body.customers || []);
  }, [query, session?.authenticated]);
  useEffect(() => {
    const timeout = setTimeout(() => void load(), 150);
    return () => clearTimeout(timeout);
  }, [load]);
  useEffect(() => {
    const locked = () => setSession({ authenticated: false });
    window.addEventListener("corner-ops-pos-locked", locked);
    return () => window.removeEventListener("corner-ops-pos-locked", locked);
  }, []);

  const selected =
    customers.find((customer) => customer.id === selectedId) || null;
  useEffect(() => {
    setEditName({ firstName: selected?.first_name || "", lastName: selected?.last_name || "" });
  }, [selected?.id]);
  useEffect(() => {
    if (!selected) {
      setLoyalty([]);
      setLoyaltyHistory([]);
      return;
    }
    fetch(
      `/api/ordering/loyalty/status?customerId=${encodeURIComponent(selected.id)}`,
    )
      .then((response) => response.json())
      .then((body) => {
        setLoyalty(body.programs || []);
        setLoyaltyHistory(body.history || []);
      })
      .catch(() => undefined);
  }, [selected]);
  async function adjust() {
    if (!selected) return;
    const response = await fetch("/api/ordering/loyalty/adjust", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...adjustment, customerId: selected.id }),
      }),
      body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Adjustment failed.");
      return;
    }
    setLoyalty(body.programs || []);
    setAdjustment({ ...adjustment, reason: "" });
    setMessage("Loyalty adjustment recorded.");
  }

  async function create() {
    const response = await fetch("/api/ordering/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: first, lastName: last, phone }),
    });
    const body = (await response.json()) as {
      customer?: Customer;
      error?: string;
    };
    if (response.status === 409) {
      setMessage(
        `Existing customer found: ${body.customer?.display_name}. Select that record instead.`,
      );
      setQuery(phone);
    } else if (response.ok) {
      setMessage("Customer created.");
      setFirst("");
      setLast("");
      setPhone("");
      await load();
    } else setMessage(body.error || "Could not create customer.");
  }
  async function saveName() {
    if (!selected || editNameBusy) return;
    setEditNameBusy(true);
    const response = await fetch("/api/ordering/customers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: selected.id, ...editName }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) setMessage(body.error || "Could not update customer name.");
    else {
      setMessage("Customer name updated.");
      await load();
    }
    setEditNameBusy(false);
  }

  async function addPhone(allowShared = false) {
    if (!selected) return;
    const response = await fetch(
      `/api/ordering/customers/${selected.id}/phones`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: newPhone,
          label: phoneLabel,
          isPrimary: phonePrimary,
          allowShared,
        }),
      },
    );
    const body = (await response.json()) as {
      duplicate?: boolean;
      matches?: DuplicateMatch[];
      error?: string;
    };
    if (response.status === 409) {
      setDuplicateMatches(body.matches || []);
      setMessage(
        "That number belongs to another active customer. Use that customer, or explicitly share the number.",
      );
      return;
    }
    if (!response.ok) {
      setMessage(body.error || "Could not add phone.");
      return;
    }
    setDuplicateMatches([]);
    setNewPhone("");
    setPhonePrimary(false);
    setMessage("Phone added.");
    await load();
  }

  async function addAddress() {
    if (!selected) return;
    const response = await fetch(
      `/api/ordering/customers/${selected.id}/addresses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(address),
      },
    );
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setMessage(body.error || "Could not add address.");
      return;
    }
    setAddress({
      label: "Home",
      line1: "",
      line2: "",
      city: "Ogdensburg",
      state: "NY",
      postalCode: "",
      isPrimary: false,
    });
    setMessage("Address added.");
    await load();
  }
  async function removeContact(
    kind: "phone" | "address",
    id: string,
    label: string,
  ) {
    if (
      !selected ||
      !window.confirm(`Remove ${label} from ${selected.display_name}?`)
    )
      return;
    const parameter = kind === "phone" ? "phoneId" : "addressId",
      response = await fetch(
        `/api/ordering/customers/${selected.id}/${kind === "phone" ? "phones" : "addresses"}?${parameter}=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
      body = await response.json();
    if (!response.ok) {
      setMessage(body.error || `Could not remove ${kind}.`);
      return;
    }
    setMessage(`${kind === "phone" ? "Phone number" : "Address"} removed.`);
    await load();
  }

  async function doMerge() {
    if (merge.length !== 2) return;
    const response = await fetch("/api/ordering/customers/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ survivorId: merge[0], mergedId: merge[1] }),
    });
    const body = (await response.json()) as { error?: string };
    setMessage(
      response.ok
        ? "Customers merged; phones, addresses, order links, and historical snapshots were preserved."
        : body.error || "Merge failed.",
    );
    setMerge([]);
    setSelectedId("");
    await load();
  }

  function useForOrder(customer: Customer) {
    window.dispatchEvent(
      new CustomEvent("corner-ops-pos-customer-selected", { detail: customer }),
    );
    setMessage(`${customer.display_name} attached to the current order.`);
  }

  async function importCrm(action: "preview" | "apply") {
    if (!importFile) return;
    setImportBusy(true);
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", importFile);
      form.set("action", action);
      const response = await fetch("/api/ordering/customers/import", {
          method: "POST",
          body: form,
        }),
        body = await response.json();
      if (!response.ok) {
        setMessage(body.error || "CRM import could not be completed.");
        return;
      }
      if (action === "preview") {
        setImportPreview(body);
        setMessage(
          `Preview ready: ${body.duplicatesCollapsed} duplicate rows will be combined.`,
        );
      } else {
        setImportPreview(null);
        setImportFile(null);
        setMessage(
          `CRM imported: ${body.batch.created_customers} new, ${body.batch.updated_customers} updated, ${body.batch.merged_customers} merged.`,
        );
        await load();
      }
    } finally {
      setImportBusy(false);
    }
  }

  if (!session) return <main className="ocPage">Loading customers…</main>;
  if (!session.authenticated)
    return (
      <PosPinGate
        onAuthenticated={(next) =>
          setSession({ authenticated: true, session: next })
        }
      />
    );

  return (
    <main className="ocPage customerWorkspace">
      <header>
        <div>
          <h1>Customers</h1>
          <p>
            Find callers, manage contact choices, and attach a customer to the
            current order.
          </p>
        </div>
      </header>
      <div className="ocTools">
        <input
          className="search"
          autoFocus
          type="search"
          placeholder="Name or phone"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {message && (
        <p className="customerMessage" role="status">
          {message}
        </p>
      )}
      <div className="customerColumns">
        <section className="customerList">
          <details className="customerCreate">
            <summary>+ NEW CUSTOMER</summary>
            <div className="customerFormRow">
              <input
                placeholder="First name"
                value={first}
                onChange={(event) => setFirst(event.target.value)}
              />
              <input
                placeholder="Last name"
                value={last}
                onChange={(event) => setLast(event.target.value)}
              />
              <input
                placeholder="Phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
              <button onClick={() => void create()}>CREATE / FIND</button>
            </div>
          </details>
          {session.session?.posRole !== "employee" && (
            <details className="customerCreate customerImport">
              <summary>IMPORT CRM</summary>
              <p>
                CSV or Excel. Existing phones, emails, and addresses are
                combined; imported addresses are not revalidated.
              </p>
              <div className="customerFormRow">
                <input
                  type="file"
                  accept=".csv,.xls,.xlsx"
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] || null);
                    setImportPreview(null);
                  }}
                />
                <button
                  disabled={!importFile || importBusy}
                  onClick={() => void importCrm("preview")}
                >
                  {importBusy ? "CHECKING…" : "PREVIEW"}
                </button>
              </div>
              {importPreview && (
                <div className="crmPreview">
                  <b>
                    {importPreview.customerGroups.toLocaleString()} customers
                    from {importPreview.sourceRows.toLocaleString()} rows
                  </b>
                  <span>
                    {importPreview.duplicatesCollapsed.toLocaleString()}{" "}
                    duplicates combined ·{" "}
                    {importPreview.phones.toLocaleString()} phones ·{" "}
                    {importPreview.emails.toLocaleString()} emails ·{" "}
                    {importPreview.addresses.toLocaleString()} addresses
                  </span>
                  <small>
                    The most frequently used imported address is listed first
                    and becomes the default when the customer has no existing
                    default.
                  </small>
                  <button
                    disabled={importBusy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Import ${importPreview.customerGroups.toLocaleString()} customer records?`,
                        )
                      )
                        void importCrm("apply");
                    }}
                  >
                    IMPORT CUSTOMERS
                  </button>
                </div>
              )}
            </details>
          )}
          <h2>
            ACTIVE CUSTOMERS <span>{customers.length}</span>
          </h2>
          {customers.map((customer) => (
            <article
              className={`customerRow ${selectedId === customer.id ? "selected" : ""}`}
              key={customer.id}
            >
              <button
                className="customerSelect"
                onClick={() => setSelectedId(customer.id)}
              >
                <b>{customer.display_name}</b>
                <span>
                  {customer.phones
                    .map((item) => item.display_phone)
                    .join(" · ") || "No phone"}
                </span>
                <small>
                  {customer.addresses.length} address
                  {customer.addresses.length === 1 ? "" : "es"} ·{" "}
                  {customer.last_order_at
                    ? `Last order ${new Date(customer.last_order_at).toLocaleDateString()}`
                    : "No orders"}
                </small>
              </button>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Select ${customer.display_name} for merge`}
                  checked={merge.includes(customer.id)}
                  onChange={(event) =>
                    setMerge((value) =>
                      event.target.checked
                        ? [...value, customer.id].slice(-2)
                        : value.filter((id) => id !== customer.id),
                    )
                  }
                />{" "}
                Merge
              </label>
            </article>
          ))}
          {merge.length === 2 && (
            <button className="mergeButton" onClick={() => void doMerge()}>
              MERGE SECOND CUSTOMER INTO FIRST
            </button>
          )}
        </section>

        <section className="customerDetail" aria-live="polite">
          {!selected && (
            <div className="customerEmpty">
              Select a customer to see phones, addresses, and order history.
            </div>
          )}
          {selected && (
            <>
              <div className="customerDetailHead">
                <div>
                  <h2>{selected.display_name}</h2>
                  <small>{selected.email || "No email"}</small>
                </div>
                <button onClick={() => useForOrder(selected)}>
                  USE FOR CURRENT ORDER
                </button>
              </div>
              <h3>NAME</h3>
              <div className="customerFormRow">
                <input aria-label="Customer first name" placeholder="First name" value={editName.firstName} onChange={(event) => setEditName((current) => ({ ...current, firstName: event.target.value }))} />
                <input aria-label="Customer last name" placeholder="Last name" value={editName.lastName} onChange={(event) => setEditName((current) => ({ ...current, lastName: event.target.value }))} />
                <button disabled={editNameBusy || (!editName.firstName.trim() && !editName.lastName.trim())} onClick={() => void saveName()}>{editNameBusy ? "SAVING…" : "SAVE NAME"}</button>
              </div>
              <h3>LOYALTY</h3>
              <div className="customerContactList">
                {loyalty.map((program) => (
                  <div key={program.programId}>
                    <b>{program.name}</b>
                    <span>
                      {program.rewardsAvailable
                        ? `${program.rewardsAvailable} FREE REWARD${program.rewardsAvailable === 1 ? "" : "S"} AVAILABLE`
                        : `${program.progress} / ${program.quantityRequired} purchases`}
                    </span>
                  </div>
                ))}
                {!loyalty.length && <p>No active loyalty programs.</p>}
              </div>
              {session.session?.posRole !== "employee" &&
                loyalty.length > 0 && (
                  <div className="customerFormRow">
                    <select
                      value={adjustment.programId}
                      onChange={(event) =>
                        setAdjustment({
                          ...adjustment,
                          programId: event.target.value,
                        })
                      }
                    >
                      <option value="">Program</option>
                      {loyalty.map((program) => (
                        <option
                          key={program.programId}
                          value={program.programId}
                        >
                          {program.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={adjustment.deltaUnits}
                      onChange={(event) =>
                        setAdjustment({
                          ...adjustment,
                          deltaUnits: Number(event.target.value),
                        })
                      }
                    />
                    <input
                      placeholder="Required adjustment reason"
                      value={adjustment.reason}
                      onChange={(event) =>
                        setAdjustment({
                          ...adjustment,
                          reason: event.target.value,
                        })
                      }
                    />
                    <button onClick={() => void adjust()}>ADJUST</button>
                  </div>
                )}
              <div className="customerHistory">
                {loyaltyHistory.slice(0, 8).map((event) => (
                  <p key={event.id}>
                    {event.delta_units > 0 ? "+" : ""}
                    {event.delta_units} ·{" "}
                    {event.entry_type.replaceAll("_", " ")}
                    {event.display_number
                      ? ` · Order #${event.display_number}`
                      : ""}
                    {event.reason ? ` · ${event.reason}` : ""}
                  </p>
                ))}
              </div>
              <h3>PHONES</h3>
              <div className="customerContactList">
                {selected.phones.map((item) => (
                  <div key={item.id}>
                    <b>{item.label || "Other"}</b>
                    <span>{item.display_phone}</span>
                    {item.is_primary && <em>Primary</em>}
                    {session.session?.posRole !== "employee" && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          void removeContact(
                            "phone",
                            item.id,
                            item.display_phone,
                          )
                        }
                      >
                        REMOVE
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="customerFormRow">
                <select
                  value={phoneLabel}
                  onChange={(event) => setPhoneLabel(event.target.value)}
                >
                  <option>Mobile</option>
                  <option>Home</option>
                  <option>Work</option>
                  <option>Other</option>
                </select>
                <input
                  placeholder="Phone number"
                  value={newPhone}
                  onChange={(event) => {
                    setNewPhone(event.target.value);
                    setDuplicateMatches([]);
                  }}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={phonePrimary}
                    onChange={(event) => setPhonePrimary(event.target.checked)}
                  />{" "}
                  Primary
                </label>
                <button onClick={() => void addPhone()}>+ PHONE</button>
              </div>
              {duplicateMatches.length > 0 && (
                <div className="duplicateWarning">
                  <strong>EXISTING CUSTOMER</strong>
                  {duplicateMatches.map((match) => (
                    <button
                      key={match.customer_id}
                      onClick={() => {
                        setQuery(match.display_phone);
                        setSelectedId(match.customer_id);
                      }}
                    >
                      {match.display_name} · {match.display_phone}
                      <small>USE CUSTOMER</small>
                    </button>
                  ))}
                  <button
                    className="sharedPhone"
                    onClick={() => void addPhone(true)}
                  >
                    SHARE NUMBER ANYWAY
                  </button>
                </div>
              )}

              <h3>EMAILS</h3>
              <div className="customerContactList">
                {(selected.emails || []).map((item) => (
                  <div key={item.id}>
                    <b>{item.label || "Email"}</b>
                    <span>{item.display_email}</span>
                    {item.is_primary && <em>Primary</em>}
                  </div>
                ))}
                {!(selected.emails || []).length && <p>No email addresses.</p>}
              </div>

              <h3>ADDRESSES</h3>
              <div className="customerContactList">
                {selected.addresses.map((item) => (
                  <div key={item.id}>
                    <b>{item.label || "Other"}</b>
                    <span>
                      {item.line1}
                      {item.line2 ? `, ${item.line2}` : ""}
                      <small>
                        {item.city}, {item.state} {item.postal_code}
                      </small>
                    </span>
                    {item.is_primary && <em>Primary</em>}
                    {session.session?.posRole !== "employee" && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          void removeContact("address", item.id, item.line1)
                        }
                      >
                        REMOVE
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="customerAddressForm">
                <select
                  value={address.label}
                  onChange={(event) =>
                    setAddress((value) => ({
                      ...value,
                      label: event.target.value,
                    }))
                  }
                >
                  <option>Home</option>
                  <option>Work</option>
                  <option>Other</option>
                </select>
                <input
                  placeholder="Street address"
                  value={address.line1}
                  onChange={(event) =>
                    setAddress((value) => ({
                      ...value,
                      line1: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="Apt / unit"
                  value={address.line2}
                  onChange={(event) =>
                    setAddress((value) => ({
                      ...value,
                      line2: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="City"
                  value={address.city}
                  onChange={(event) =>
                    setAddress((value) => ({
                      ...value,
                      city: event.target.value,
                    }))
                  }
                />
                <input
                  aria-label="State"
                  value={address.state}
                  onChange={(event) =>
                    setAddress((value) => ({
                      ...value,
                      state: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="ZIP"
                  value={address.postalCode}
                  onChange={(event) =>
                    setAddress((value) => ({
                      ...value,
                      postalCode: event.target.value,
                    }))
                  }
                />
                <label>
                  <input
                    type="checkbox"
                    checked={address.isPrimary}
                    onChange={(event) =>
                      setAddress((value) => ({
                        ...value,
                        isPrimary: event.target.checked,
                      }))
                    }
                  />{" "}
                  Primary
                </label>
                <button onClick={() => void addAddress()}>+ ADDRESS</button>
              </div>
              <h3>ORDER HISTORY</h3>
              <p className="customerHistory">
                {selected.last_order_at
                  ? `Last order ${new Date(selected.last_order_at).toLocaleString()}`
                  : "No orders yet."}
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
