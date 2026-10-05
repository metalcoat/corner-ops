"use client";
// Supplier costs: which supplier to buy each item from, given what we use each
// week, each supplier's minimum order, delivery fee, and truck days.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type Window = { orderBy: string | null; deliveryDate: string } | null;
type Supplier = {
  id: string; name: string; minimumOrderCents: number; deliveryFeeCents: number; freeDeliveryOverCents: number | null;
  deliveryDays: number[]; cutoffTime: string; cutoffDaysBefore: number; shipsInDays: number | null;
  contactName: string; email: string; phone: string; accountNumber: string; notes: string; next: Window;
};
type Price = { supplierId: string; caseQuantity: number; caseUnit: string; casePriceCents: number; vendorSku: string; quotedAt: string | null; unitCostCents: number | null };
type Item = {
  id: string; name: string; category: string; baseUnit: string; onHand: number; par: number | null; lastCountedAt: string | null;
  weeklyUsage: number | null; usageSource: "set" | "history" | "none"; runOutDate: string | null; need: number; requests: number;
  prices: Record<string, Price>; bestUnitCostCents: number | null; weeklySpreadCents: number;
};
type Line = { itemId: string; name: string; cases: number; casePriceCents: number; costCents: number; unitCostCents: number; late: boolean };
type Order = { supplierId: string; name: string; lines: Line[]; subtotalCents: number; feeCents: number; totalCents: number; minimumOrderCents: number; shortOfMinimumCents: number; delivery: Window };
type Plan = { label: string; orders: Order[]; totalCents: number; feesCents: number; missing: string[]; meetsMinimums: boolean; lateItems: number };
type Request = { id: string; item_name: string | null; item_text: string; quantity: string | null; unit: string; urgency: string; note: string; status: string; requested_by_name: string; requested_at: string };
type Spec = { keywords: string; maxUnitCostCents: number | null; minPack: number | null; maxPack: number | null };
type Match = { id: string; supplier_id: string; supplier_name: string; vendor_sku: string; description: string; brand: string; pack_quantity: number; pack_unit: string; price_cents: number; unitCostCents: number; isNew: boolean };
type PriceChange = { id: string; supplier_name: string; description: string; previous: number; price_cents: number; seen_at: string; item_name: string };
type SearchResult = { id: string; supplier_name: string; vendor_sku: string; description: string; brand: string; pack_quantity: number; pack_unit: string; price_cents: number; unitCostCents: number | null; last_seen_at: string };
type Data = { specs: Record<string, Spec>; matches: Record<string, Match[]>; priceChanges: PriceChange[]; catalogSize: number; mode: "week" | "order"; suppliers: Supplier[]; items: Item[]; analysis: { best: Plan | null; single: Plan[]; floorCents: number }; requests: Request[]; unpriced: string[]; noUsage: number };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const unitMoney = (c: number) => (c < 100 ? `${(c).toFixed(1)}¢` : money(c));
const qty = (n: number | null | undefined) => (n == null ? "—" : (Math.round(n * 100) / 100).toLocaleString("en-US"));
// Supplier cutoffs are store (Eastern) times, whatever time zone the device is set to.
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const dollars = (cents: number | null | undefined) => (cents == null ? "" : String(cents / 100));
const toCents = (value: string) => (value.trim() === "" ? null : Math.round(Number(value.replace(/[$,]/g, "")) * 100));

async function message(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error || `Request failed (${response.status}).`;
}

export default function SupplierCosts() {
  const [data, setData] = useState<Data | null>(null);
  const [mode, setMode] = useState<"week" | "order">("week");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<{ itemId: string; supplierId: string; caseQuantity: string; caseUnit: string; price: string; sku: string } | null>(null);
  const [usageEdit, setUsageEdit] = useState<{ itemId: string; weekly: string; par: string } | null>(null);
  const [supplierEdit, setSupplierEdit] = useState<(Omit<Supplier, "minimumOrderCents" | "deliveryFeeCents" | "freeDeliveryOverCents" | "shipsInDays" | "next"> & { minimum: string; fee: string; freeOver: string; ships: string }) | null>(null);
  const [importing, setImporting] = useState({ supplierId: "", text: "" });
  const [filter, setFilter] = useState("");
  const [specEdit, setSpecEdit] = useState<{ itemId: string; keywords: string; maxUnit: string; minPack: string; maxPack: string } | null>(null);
  const [search, setSearch] = useState({ query: "", unit: "lb", itemId: "" });
  const [results, setResults] = useState<SearchResult[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/ordering/supplier-costs?mode=${mode}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await message(response));
      setData(await response.json());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Supplier costs could not load.");
    }
  }, [mode]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function post(key: string, body: Record<string, unknown>, done: (result: Record<string, unknown>) => string) {
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/ordering/supplier-costs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await message(response));
      setNotice(done(await response.json()));
      await load();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't save.");
      return false;
    } finally {
      setBusy("");
    }
  }

  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.items ?? []).filter((item) => !q || item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q));
  }, [data?.items, filter]);

  if (!data) return <main className="costsPage"><p className="costsEmpty">{error || "Loading supplier costs…"}</p></main>;
  const best = data.analysis.best;
  const singles = data.analysis.single;
  const bestSingle = singles.find((plan) => !plan.missing.length && plan.meetsMinimums) ?? singles.find((plan) => !plan.missing.length);
  const savings = best && bestSingle ? bestSingle.totalCents - best.totalCents : 0;
  const openRequests = data.requests.filter((r) => r.status === "open");
  const suppliers = data.suppliers;
  const missingTerms = suppliers.filter((s) => !s.deliveryDays.length && s.shipsInDays == null);

  const supplierForm = (key: string) =>
    supplierEdit && (
      <form
                key={key}
                className="termCard editing"
                onSubmit={(e) => {
                  e.preventDefault();
                  void post(
                    "supplier",
                    {
                      action: "save_supplier",
                      ...supplierEdit,
                      minimumOrderCents: toCents(supplierEdit.minimum) ?? 0,
                      deliveryFeeCents: toCents(supplierEdit.fee) ?? 0,
                      freeDeliveryOverCents: toCents(supplierEdit.freeOver),
                      shipsInDays: supplierEdit.ships.trim() === "" ? null : Number(supplierEdit.ships),
                    },
                    () => `Saved ${supplierEdit.name}.`,
                  ).then((ok) => ok && setSupplierEdit(null));
                }}
              >
                <label>Name<input value={supplierEdit.name} onChange={(e) => setSupplierEdit({ ...supplierEdit, name: e.target.value })} /></label>
                <div className="termRow">
                  <label>Minimum order $<input inputMode="decimal" value={supplierEdit.minimum} onChange={(e) => setSupplierEdit({ ...supplierEdit, minimum: e.target.value })} /></label>
                  <label>Delivery fee $<input inputMode="decimal" value={supplierEdit.fee} onChange={(e) => setSupplierEdit({ ...supplierEdit, fee: e.target.value })} /></label>
                  <label>Free delivery over $<input inputMode="decimal" value={supplierEdit.freeOver} placeholder="never" onChange={(e) => setSupplierEdit({ ...supplierEdit, freeOver: e.target.value })} /></label>
                </div>
                <fieldset>
                  <legend>Truck days</legend>
                  <div className="dayChips">
                    {DAYS.map((label, d) => (
                      <button
                        type="button"
                        key={label}
                        aria-pressed={supplierEdit.deliveryDays.includes(d)}
                        onClick={() => setSupplierEdit({ ...supplierEdit, deliveryDays: supplierEdit.deliveryDays.includes(d) ? supplierEdit.deliveryDays.filter((x) => x !== d) : [...supplierEdit.deliveryDays, d] })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="termRow">
                  <label>Order by<input type="time" value={supplierEdit.cutoffTime} onChange={(e) => setSupplierEdit({ ...supplierEdit, cutoffTime: e.target.value })} /></label>
                  <label>Days before truck<input inputMode="numeric" value={String(supplierEdit.cutoffDaysBefore)} onChange={(e) => setSupplierEdit({ ...supplierEdit, cutoffDaysBefore: Number(e.target.value.replace(/\D/g, "") || 0) })} /></label>
                  <label>Or ships in (business days)<input inputMode="numeric" value={supplierEdit.ships} placeholder="—" onChange={(e) => setSupplierEdit({ ...supplierEdit, ships: e.target.value.replace(/\D/g, "") })} /></label>
                </div>
                <div className="termRow">
                  <label>Rep<input value={supplierEdit.contactName} onChange={(e) => setSupplierEdit({ ...supplierEdit, contactName: e.target.value })} /></label>
                  <label>Phone<input value={supplierEdit.phone} onChange={(e) => setSupplierEdit({ ...supplierEdit, phone: e.target.value })} /></label>
                  <label>Account #<input value={supplierEdit.accountNumber} onChange={(e) => setSupplierEdit({ ...supplierEdit, accountNumber: e.target.value })} /></label>
                </div>
                <label>Notes<input value={supplierEdit.notes} onChange={(e) => setSupplierEdit({ ...supplierEdit, notes: e.target.value })} placeholder="e.g. fuel surcharge $5, no Saturday delivery" /></label>
                <div className="termActions">
                  <button type="button" className="ghost" onClick={() => setSupplierEdit(null)}>CANCEL</button>
                  <button disabled={busy === "supplier"}>{busy === "supplier" ? "SAVING…" : "SAVE"}</button>
                </div>
              </form>
    );

  return (
    <main className="costsPage">
      <header className="costsHeader">
        <div>
          <p className="eyebrow">INVENTORY</p>
          <h1>Supplier costs</h1>
          <p className="sub">Cheapest way to buy what we use, after minimums, delivery fees, and truck days.</p>
        </div>
        <div className="modeSwitch" role="tablist" aria-label="What to price">
          <button role="tab" aria-selected={mode === "week"} onClick={() => setMode("week")}>
            <b>Typical week</b>
            <small>What we use in a week</small>
          </button>
          <button role="tab" aria-selected={mode === "order"} onClick={() => setMode("order")}>
            <b>Order now</b>
            <small>Up to par, minus what&apos;s on the shelf, plus staff requests</small>
          </button>
        </div>
      </header>
      {error && <p className="costsError" role="alert">{error} <button onClick={() => setError("")}>OK</button></p>}
      {notice && <p className="costsNotice" role="status">{notice}</p>}

      <section className="costsSummary">
        <article className="big">
          <span>Best plan {mode === "week" ? "per week" : "for this order"}</span>
          <strong>{best ? money(best.totalCents) : "—"}</strong>
          <small>{best ? best.label : "Add prices to see a plan"}</small>
        </article>
        <article>
          <span>Saves vs. one supplier</span>
          <strong className={savings > 0 ? "good" : ""}>{bestSingle && best ? money(Math.max(0, savings)) : "—"}</strong>
          <small>{bestSingle ? `vs. ${bestSingle.label.replace("Everything from ", "all ")}` : "No supplier carries everything yet"}{savings > 0 && mode === "week" ? ` · ${money(savings * 52)}/yr` : ""}</small>
        </article>
        <article>
          <span>Lowest prices, ignoring fees</span>
          <strong>{money(data.analysis.floorCents)}</strong>
          <small>{best ? `${money(best.feesCents)} in delivery fees in the plan` : ""}</small>
        </article>
        <article>
          <span>Staff requests</span>
          <strong className={openRequests.some((r) => r.urgency === "out") ? "bad" : ""}>{openRequests.length}</strong>
          <small>{openRequests.filter((r) => r.urgency === "out").length} marked out</small>
        </article>
      </section>

      {(data.unpriced.length > 0 || data.noUsage > 0 || missingTerms.length > 0) && (
        <ul className="costsWarnings">
          {data.unpriced.length > 0 && <li><b>{data.unpriced.length} item{data.unpriced.length === 1 ? "" : "s"} have no prices yet</b> ({data.unpriced.slice(0, 5).join(", ")}{data.unpriced.length > 5 ? "…" : ""}). Add a price in the table or paste an order guide below.</li>}
          {data.noUsage > 0 && <li><b>{data.noUsage} item{data.noUsage === 1 ? "" : "s"} have no weekly usage.</b> Type it in the table, or have staff count stock on the Stock sheet each week and it fills in on its own.</li>}
          {missingTerms.length > 0 && <li><b>No delivery days for {missingTerms.map((s) => s.name).join(", ")}.</b> Set truck days and order-by times below so plans use real delivery dates.</li>}
        </ul>
      )}

      {best && best.orders.length > 0 && (
        <section className="costsSection">
          <div className="sectionHead">
            <h2>Recommended split</h2>
            {mode === "order" && (
              <button disabled={busy === "orders"} onClick={() => void post("orders", { action: "create_orders", mode }, (r) => `Created ${r.purchaseOrders} draft purchase order${r.purchaseOrders === 1 ? "" : "s"}. Find them in Inventory → Suppliers/PO.`)}>
                {busy === "orders" ? "CREATING…" : "CREATE DRAFT ORDERS"}
              </button>
            )}
          </div>
          <div className="orderCards">
            {best.orders.map((order) => (
              <article key={order.supplierId} className={order.shortOfMinimumCents ? "short" : ""}>
                <header>
                  <h3>{order.name}</h3>
                  {order.delivery ? (
                    <p>
                      Arrives <b>{day(order.delivery.deliveryDate)}</b>
                      {order.delivery.orderBy && <> · order by <b>{when(order.delivery.orderBy)}</b></>}
                    </p>
                  ) : (
                    <p className="muted">Set delivery days to see dates</p>
                  )}
                </header>
                <ul>
                  {order.lines.map((line) => (
                    <li key={line.itemId} className={line.late ? "late" : ""}>
                      <span>{line.cases}×</span>
                      <b>{line.name}</b>
                      <em>{money(line.costCents)}</em>
                      {line.late && <small>Arrives after we run out</small>}
                    </li>
                  ))}
                </ul>
                <dl>
                  <div><dt>Items</dt><dd>{money(order.subtotalCents)}</dd></div>
                  <div><dt>Delivery</dt><dd>{order.feeCents ? money(order.feeCents) : "Free"}</dd></div>
                  <div className="total"><dt>Total</dt><dd>{money(order.totalCents)}</dd></div>
                </dl>
                {order.minimumOrderCents > 0 && (
                  <p className={`minimum ${order.shortOfMinimumCents ? "bad" : "good"}`}>
                    {order.shortOfMinimumCents ? `${money(order.shortOfMinimumCents)} short of the ${money(order.minimumOrderCents)} minimum` : `Meets the ${money(order.minimumOrderCents)} minimum`}
                  </p>
                )}
              </article>
            ))}
          </div>
          {best.missing.length > 0 && <p className="muted">Not in this plan (no supplier price): {best.missing.map((id) => data.items.find((i) => i.id === id)?.name).join(", ")}</p>}
        </section>
      )}

      {singles.length > 0 && (
        <section className="costsSection">
          <h2>If you bought everything from one supplier</h2>
          <table className="singleTable">
            <thead>
              <tr><th>Supplier</th><th>Items</th><th>Delivery</th><th>Total</th><th>Vs. best plan</th><th>Next truck</th></tr>
            </thead>
            <tbody>
              {singles.map((plan) => {
                const order = plan.orders[0];
                const supplier = suppliers.find((s) => s.id === order?.supplierId);
                return (
                  <tr key={plan.label}>
                    <td><b>{supplier?.name}</b></td>
                    <td>{order?.lines.length ?? 0} of {(order?.lines.length ?? 0) + plan.missing.length}{plan.missing.length ? <small className="bad"> · {plan.missing.length} not carried</small> : null}</td>
                    <td>{order ? (order.feeCents ? money(order.feeCents) : "Free") : "—"}{order?.shortOfMinimumCents ? <small className="bad"> · {money(order.shortOfMinimumCents)} under minimum</small> : null}</td>
                    <td><b>{money(plan.totalCents)}</b></td>
                    <td>{best ? (plan.missing.length ? "—" : <span className={plan.totalCents - best.totalCents > 0 ? "bad" : "good"}>+{money(Math.max(0, plan.totalCents - best.totalCents))}</span>) : "—"}</td>
                    <td>{supplier?.next ? day(supplier.next.deliveryDate) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {openRequests.length > 0 && (
        <section className="costsSection">
          <h2>What staff say we need</h2>
          <ul className="requestRows">
            {openRequests.map((r) => (
              <li key={r.id} className={r.urgency}>
                <span className="tag">{r.urgency === "out" ? "OUT" : "LOW"}</span>
                <div>
                  <b>{r.item_name || r.item_text}{r.quantity ? ` · ${qty(Number(r.quantity))} ${r.unit}` : ""}</b>
                  <small>{r.requested_by_name} · {when(r.requested_at)}{r.note ? ` · “${r.note}”` : ""}{!r.item_name ? " · not a stock item yet" : ""}</small>
                </div>
                <button disabled={Boolean(busy)} onClick={() => void post(`r:${r.id}`, { action: "resolve_request", id: r.id, status: "ordered" }, () => "Marked ordered.")}>ORDERED</button>
                <button className="ghost" disabled={Boolean(busy)} onClick={() => void post(`r:${r.id}`, { action: "resolve_request", id: r.id, status: "dismissed" }, () => "Skipped.")}>SKIP</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {specEdit && (
        <section className="costsSection specCard">
          <h2>What {data.items.find((i) => i.id === specEdit.itemId)?.name} has to be</h2>
          <p className="muted">Used to find products at any supplier that fit, including new ones from the daily price files. Pack size and price are per {data.items.find((i) => i.id === specEdit.itemId)?.baseUnit}.</p>
          <form
            className="specForm"
            onSubmit={(e) => {
              e.preventDefault();
              void post("spec", { action: "save_spec", itemId: specEdit.itemId, keywords: specEdit.keywords, maxUnitCostCents: specEdit.maxUnit === "" ? "" : Math.round(Number(specEdit.maxUnit) * 100 * 100) / 100, minPack: specEdit.minPack, maxPack: specEdit.maxPack }, () => "Specs saved.").then((ok) => ok && setSpecEdit(null));
            }}
          >
            <label>Words it must contain<input autoFocus value={specEdit.keywords} onChange={(e) => setSpecEdit({ ...specEdit, keywords: e.target.value })} placeholder="chicken, tender, breaded" /><small>Comma-separated; every word must be in the description.</small></label>
            <label>Max price per {data.items.find((i) => i.id === specEdit.itemId)?.baseUnit} ($)<input inputMode="decimal" value={specEdit.maxUnit} onChange={(e) => setSpecEdit({ ...specEdit, maxUnit: e.target.value })} placeholder="any" /></label>
            <label>Case at least<input inputMode="decimal" value={specEdit.minPack} onChange={(e) => setSpecEdit({ ...specEdit, minPack: e.target.value })} placeholder="any" /></label>
            <label>Case at most<input inputMode="decimal" value={specEdit.maxPack} onChange={(e) => setSpecEdit({ ...specEdit, maxPack: e.target.value })} placeholder="any" /></label>
            <div className="termActions">
              <button type="button" className="ghost" onClick={() => setSpecEdit(null)}>CANCEL</button>
              <button disabled={busy === "spec"}>SAVE SPECS</button>
            </div>
          </form>
        </section>
      )}

      {Object.keys(data.matches).length > 0 && (
        <section className="costsSection">
          <h2>Products that meet your specs</h2>
          <p className="muted">From every supplier&apos;s catalog (last 30 days), cheapest per unit first. NEW means it showed up in the last two weeks.</p>
          <div className="matchGroups">
            {Object.entries(data.matches).map(([itemId, matches]) => {
              const item = data.items.find((i) => i.id === itemId);
              if (!item) return null;
              return (
                <article key={itemId}>
                  <h3>
                    {item.name}
                    <small>now best {item.bestUnitCostCents != null ? `${unitMoney(item.bestUnitCostCents)}/${item.baseUnit}` : "—"}</small>
                  </h3>
                  <ul>
                    {matches.map((m) => {
                      const cheaper = item.bestUnitCostCents == null || m.unitCostCents < item.bestUnitCostCents;
                      return (
                        <li key={m.id}>
                          <div>
                            <b>{m.description}{m.isNew && <span className="newTag">NEW</span>}</b>
                            <small>{m.supplier_name}{m.vendor_sku ? ` #${m.vendor_sku}` : ""}{m.brand ? ` · ${m.brand}` : ""} · {qty(m.pack_quantity)} {m.pack_unit} · {money(m.price_cents)}</small>
                          </div>
                          <strong className={cheaper ? "good" : ""}>{unitMoney(m.unitCostCents)}/{item.baseUnit}</strong>
                          <button disabled={Boolean(busy)} onClick={() => void post(`use:${m.id}`, { action: "use_product", itemId, catalogId: m.id }, () => `${m.supplier_name} will now price ${item.name} as ${m.description}.`)}>USE</button>
                        </li>
                      );
                    })}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {data.priceChanges.length > 0 && (
        <section className="costsSection">
          <h2>Price changes on what we buy (last 2 weeks)</h2>
          <ul className="changeRows">
            {data.priceChanges.map((c) => {
              const delta = c.price_cents - c.previous;
              return (
                <li key={c.id}>
                  <b>{c.item_name}</b>
                  <small>{c.supplier_name} · {c.description}</small>
                  <span>{money(c.previous)} → {money(c.price_cents)}</span>
                  <strong className={delta > 0 ? "bad" : "good"}>{delta > 0 ? "+" : "−"}{money(Math.abs(delta))} ({((delta / c.previous) * 100).toFixed(1)}%)</strong>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="costsSection">
        <h2>Search all suppliers</h2>
        <p className="muted">{data.catalogSize ? `${data.catalogSize.toLocaleString()} products on file from order guides and price files.` : "Paste or drop in a supplier's full order guide to search it here."}</p>
        <form
          className="searchForm"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy("search");
            fetch("/api/ordering/supplier-costs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "search_catalog", query: search.query, unit: search.unit }) })
              .then(async (r) => (r.ok ? setResults((await r.json()).results) : setError(await message(r))))
              .finally(() => setBusy(""));
          }}
        >
          <input value={search.query} onChange={(e) => setSearch({ ...search, query: e.target.value })} placeholder="e.g. chicken tender 4 oz" aria-label="Search products" />
          <label>Price per<select value={search.unit} onChange={(e) => setSearch({ ...search, unit: e.target.value })}>{["lb", "oz", "each", "gal", "qt"].map((u) => <option key={u}>{u}</option>)}</select></label>
          <button disabled={!search.query.trim() || busy === "search"}>{busy === "search" ? "SEARCHING…" : "SEARCH"}</button>
        </form>
        {results && (
          results.length === 0 ? <p className="costsEmpty">Nothing matches.</p> : (
            <table className="singleTable">
              <thead><tr><th>Product</th><th>Supplier</th><th>Pack</th><th>Case</th><th>Per {search.unit}</th><th>Use for</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.description}</b>{r.brand ? <small> · {r.brand}</small> : null}</td>
                    <td>{r.supplier_name}{r.vendor_sku ? <small> #{r.vendor_sku}</small> : null}</td>
                    <td>{qty(r.pack_quantity)} {r.pack_unit}</td>
                    <td>{money(r.price_cents)}</td>
                    <td><b>{r.unitCostCents != null ? unitMoney(r.unitCostCents) : "—"}</b></td>
                    <td>
                      <select
                        aria-label={`Use ${r.description} for an item`}
                        value=""
                        onChange={(e) => e.target.value && void post(`use:${r.id}`, { action: "use_product", itemId: e.target.value, catalogId: r.id }, () => `Now pricing that item with ${r.description}.`)}
                      >
                        <option value="">Use for…</option>
                        {data.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </section>

      <section className="costsSection">
        <div className="sectionHead">
          <h2>Prices by item</h2>
          <input className="filter" placeholder="Filter items" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter items" />
        </div>
        <p className="muted">Tap a price to change it. Green is the cheapest per {"unit"}. Weekly use comes from sales, waste and staff counts unless you type it.</p>
        <div className="gridScroll">
          <table className="priceGrid">
            <thead>
              <tr>
                <th>Item</th>
                <th>On hand</th>
                <th>Use / week</th>
                <th>{mode === "week" ? "Week's need" : "To order"}</th>
                {suppliers.map((s) => <th key={s.id}>{s.name}</th>)}
                <th>Spread / wk</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <Fragment key={item.id}>
                  {(index === 0 || items[index - 1].category !== item.category) && (
                    <tr className="category"><td colSpan={5 + suppliers.length}>{item.category || "Other"}</td></tr>
                  )}
                  <tr>
                    <th scope="row">
                      <b>{item.name}</b>
                      <small>per {item.baseUnit}{item.requests ? ` · ${item.requests} request${item.requests === 1 ? "" : "s"}` : ""}</small>
                      <button
                        className="specLink"
                        onClick={() => {
                          const spec = data.specs[item.id];
                          setSpecEdit({ itemId: item.id, keywords: spec?.keywords ?? "", maxUnit: spec?.maxUnitCostCents == null ? "" : String(spec.maxUnitCostCents / 100), minPack: spec?.minPack == null ? "" : String(spec.minPack), maxPack: spec?.maxPack == null ? "" : String(spec.maxPack) });
                        }}
                      >
                        {data.specs[item.id]?.keywords ? `specs: ${data.specs[item.id].keywords}` : "+ specs"}
                        {data.matches[item.id]?.length ? <b> · {data.matches[item.id].length} found</b> : null}
                      </button>
                    </th>
                    <td>
                      {qty(item.onHand)}
                      {item.runOutDate && <small className={item.runOutDate <= new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) ? "bad" : ""}>out ~{day(item.runOutDate)}</small>}
                    </td>
                    <td>
                      {usageEdit?.itemId === item.id ? (
                        <form
                          className="usageForm"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void post("usage", { action: "save_usage", itemId: item.id, weeklyUsage: usageEdit.weekly, par: usageEdit.par }, () => `Saved ${item.name}.`).then((ok) => ok && setUsageEdit(null));
                          }}
                        >
                          <label>Use/wk<input autoFocus inputMode="decimal" value={usageEdit.weekly} placeholder="auto" onChange={(e) => setUsageEdit({ ...usageEdit, weekly: e.target.value })} /></label>
                          <label>Par<input inputMode="decimal" value={usageEdit.par} onChange={(e) => setUsageEdit({ ...usageEdit, par: e.target.value })} /></label>
                          <button>SAVE</button>
                          <button type="button" className="ghost" onClick={() => setUsageEdit(null)}>×</button>
                        </form>
                      ) : (
                        <button className="cellButton" onClick={() => setUsageEdit({ itemId: item.id, weekly: item.usageSource === "set" ? String(item.weeklyUsage ?? "") : "", par: item.par == null ? "" : String(item.par) })}>
                          {qty(item.weeklyUsage)}
                          <small>{item.usageSource === "set" ? "typed in" : item.usageSource === "history" ? "from history" : "tap to set"}</small>
                        </button>
                      )}
                    </td>
                    <td>{qty(item.need)}</td>
                    {suppliers.map((s) => {
                      const price = item.prices[s.id];
                      const cheapest = price?.unitCostCents != null && price.unitCostCents === item.bestUnitCostCents && Object.keys(item.prices).length > 1;
                      const open = editing?.itemId === item.id && editing.supplierId === s.id;
                      return (
                        <td key={s.id} className={cheapest ? "cheapest" : ""}>
                          {open ? (
                            <form
                              className="priceForm"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void post("price", { action: "save_price", itemId: item.id, supplierId: s.id, caseQuantity: Number(editing.caseQuantity), caseUnit: editing.caseUnit, casePriceCents: toCents(editing.price), vendorSku: editing.sku }, () => `Saved ${s.name} price for ${item.name}.`).then((ok) => ok && setEditing(null));
                              }}
                            >
                              <label>Pack<span><input autoFocus inputMode="decimal" value={editing.caseQuantity} onChange={(e) => setEditing({ ...editing, caseQuantity: e.target.value })} /><input value={editing.caseUnit} onChange={(e) => setEditing({ ...editing, caseUnit: e.target.value })} aria-label="Pack unit" /></span></label>
                              <label>Case $<input inputMode="decimal" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} /></label>
                              <label>Item #<input value={editing.sku} onChange={(e) => setEditing({ ...editing, sku: e.target.value })} /></label>
                              <div>
                                <button>SAVE</button>
                                {price && <button type="button" className="ghost" onClick={() => void post("price", { action: "save_price", itemId: item.id, supplierId: s.id, remove: true }, () => "Price removed.").then((ok) => ok && setEditing(null))}>REMOVE</button>}
                                <button type="button" className="ghost" onClick={() => setEditing(null)}>×</button>
                              </div>
                            </form>
                          ) : (
                            <button
                              className="cellButton"
                              onClick={() => setEditing({ itemId: item.id, supplierId: s.id, caseQuantity: price ? String(price.caseQuantity) : "", caseUnit: price?.caseUnit ?? item.baseUnit, price: price ? dollars(price.casePriceCents) : "", sku: price?.vendorSku ?? "" })}
                            >
                              {price ? (
                                <>
                                  {price.unitCostCents != null ? unitMoney(price.unitCostCents) : "?"}
                                  <small>{qty(price.caseQuantity)} {price.caseUnit} · {money(price.casePriceCents)}</small>
                                </>
                              ) : (
                                <span className="add">+ price</span>
                              )}
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td>{item.weeklySpreadCents ? money(item.weeklySpreadCents) : "—"}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 && <p className="costsEmpty">No stock items yet. Paste an order guide below and they&apos;re added for you.</p>}
      </section>

      <section className="costsSection">
        <h2>Paste a supplier&apos;s order guide</h2>
        <p className="muted">Either a short list, one item per line: <code>Item name, pack size, pack unit, case price, item #</code> (new items are added), or a supplier&apos;s whole export with its header row (Sysco/US Foods/PFG/Webstaurant columns are recognized): it updates prices on what we buy and fills the catalog for searching. Files dropped in <code>/opt/corner-ops/supplier-prices/&lt;supplier name&gt;/</code> on the store server load automatically.</p>
        <form
          className="importForm"
          onSubmit={(e) => {
            e.preventDefault();
            void post("import", { action: "import_prices", ...importing }, (r) => `Read ${r.catalog} product${r.catalog === 1 ? "" : "s"}; ${r.saved} priced for our items${r.created ? `, added ${r.created} new item${r.created === 1 ? "" : "s"}` : ""}${r.priceChanges ? `, ${r.priceChanges} price change${r.priceChanges === 1 ? "" : "s"}` : ""}${(r.skipped as string[]).length ? `. Skipped ${(r.skipped as string[]).length}: ${(r.skipped as string[]).slice(0, 3).join("; ")}` : ""}.`).then((ok) => ok && setImporting({ supplierId: importing.supplierId, text: "" }));
          }}
        >
          <select value={importing.supplierId} onChange={(e) => setImporting({ ...importing, supplierId: e.target.value })} aria-label="Supplier">
            <option value="">Choose supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <textarea rows={5} value={importing.text} onChange={(e) => setImporting({ ...importing, text: e.target.value })} placeholder={"Oven roasted turkey breast, 20, lb, 84.50, 4521187\nDeli cups 16 oz, 1000, each, 61.99"} />
          <button disabled={!importing.supplierId || !importing.text.trim() || busy === "import"}>{busy === "import" ? "IMPORTING…" : "IMPORT PRICES"}</button>
        </form>
      </section>

      <section className="costsSection">
        <h2>Supplier terms</h2>
        <p className="muted">Minimums, fees and truck days are on your account sheet or from your rep. Shipped suppliers (WebstaurantStore) use “ships in” days instead of truck days.</p>
        <div className="termCards">
          {suppliers.map((s) =>
            supplierEdit?.id === s.id ? (
              supplierForm(s.id)
            ) : (
              <article key={s.id} className="termCard">
                <header>
                  <h3>{s.name}</h3>
                  <button
                    className="ghost"
                    onClick={() =>
                      setSupplierEdit({
                        ...s,
                        minimum: dollars(s.minimumOrderCents),
                        fee: dollars(s.deliveryFeeCents),
                        freeOver: dollars(s.freeDeliveryOverCents),
                        ships: s.shipsInDays == null ? "" : String(s.shipsInDays),
                      })
                    }
                  >
                    EDIT
                  </button>
                </header>
                <dl>
                  <div><dt>Minimum</dt><dd>{s.minimumOrderCents ? money(s.minimumOrderCents) : "None set"}</dd></div>
                  <div><dt>Delivery</dt><dd>{s.deliveryFeeCents ? money(s.deliveryFeeCents) : "Free"}{s.freeDeliveryOverCents != null ? ` (free over ${money(s.freeDeliveryOverCents)})` : ""}</dd></div>
                  <div>
                    <dt>Schedule</dt>
                    <dd>
                      {s.deliveryDays.length
                        ? `${s.deliveryDays.toSorted().map((d) => DAYS[d]).join(", ")} · order by ${s.cutoffTime}${s.cutoffDaysBefore ? `, ${s.cutoffDaysBefore} day${s.cutoffDaysBefore === 1 ? "" : "s"} before` : " same day"}`
                        : s.shipsInDays != null
                          ? `Ships in ${s.shipsInDays} business days`
                          : "Not set"}
                    </dd>
                  </div>
                  <div><dt>Next</dt><dd>{s.next ? <>{day(s.next.deliveryDate)}{s.next.orderBy ? <> · order by {when(s.next.orderBy)}</> : null}</> : "—"}</dd></div>
                  {s.contactName && <div><dt>Rep</dt><dd>{s.contactName}{s.phone ? ` · ${s.phone}` : ""}</dd></div>}
                </dl>
              </article>
            ),
          )}
          {!(supplierEdit && !supplierEdit.id) && <button
            className="termCard addSupplier"
            onClick={() => setSupplierEdit({ id: "", name: "", deliveryDays: [], cutoffTime: "16:00", cutoffDaysBefore: 1, contactName: "", email: "", phone: "", accountNumber: "", notes: "", minimum: "", fee: "", freeOver: "", ships: "" })}
          >
            + Add supplier
          </button>}
          {supplierEdit && !supplierEdit.id && supplierForm("new")}
        </div>
      </section>
    </main>
  );
}
