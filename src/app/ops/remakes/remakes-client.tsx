"use client";

import { useEffect, useState } from "react";
import { storeLocalTimeToIso } from "@/lib/ordering-remake-time";

type Summary = { id: string; display_number: string; customer_name: string; customer_phone: string; created_at: string; status: string; service_type: string; delivery_address: string | null };
type Item = { id: string; item_name_snapshot: string; variant_name_snapshot?: string; quantity: number; cancelled_quantity?: number; modifiers?: Array<{ option_name_snapshot: string; print_on_ticket?: boolean }> };
type Detail = Summary & { items: Item[]; delivery_unit?: string | null };
type Result = { orderId: string; orderNumber: string; alreadyCreated: boolean; printStatus: string; printMessage: string };

const dateLabel = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const itemLabel = (item: Item) => [item.variant_name_snapshot, item.item_name_snapshot].filter(Boolean).join(" ");

export default function ManagerRemakesClient() {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Summary[]>([]);
  const [order, setOrder] = useState<Detail | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [specialItem, setSpecialItem] = useState("");
  const [reason, setReason] = useState("");
  const [serviceType, setServiceType] = useState<"pickup" | "delivery">("pickup");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [unit, setUnit] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [timing, setTiming] = useState<"asap" | "scheduled">("asap");
  const [scheduled, setScheduled] = useState("");
  const [mutationId, setMutationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [printEnabled, setPrintEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void fetch("/api/ordering/manager-remakes?settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not load print settings.")))
      .then((body) => setPrintEnabled(Boolean(body.printSettings.externalKitchenAutoPrint)))
      .catch(() => setPrintEnabled(null));
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/ordering/manager-remakes?q=${encodeURIComponent(query.trim())}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not search orders.");
        setMatches(body.orders || []);
        setError("");
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not search orders."); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  async function selectOrder(summary: Summary) {
    setError(""); setResult(null);
    try {
      const response = await fetch(`/api/ordering/manager-remakes?id=${encodeURIComponent(summary.id)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not open this order.");
      const detail = body.order as Detail;
      setOrder(detail); setQuantities({}); setSpecialItem(""); setReason("");
      setServiceType(detail.service_type === "delivery" ? "delivery" : "pickup");
      setCustomerName(detail.customer_name || ""); setPhone(detail.customer_phone || "");
      setAddress(detail.delivery_address || ""); setUnit(detail.delivery_unit || "");
      setDeliveryNotes(""); setTiming("asap"); setScheduled(""); setMutationId(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this order."); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!order || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/ordering/manager-remakes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        originalOrderId: order.id, clientMutationId: mutationId,
        items: Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
        specialItem, reason, serviceType, customerName, phone, address, unit, deliveryNotes,
        scheduledFor: timing === "scheduled" && scheduled ? storeLocalTimeToIso(scheduled) : null,
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not send the remake.");
      setResult(body); setMutationId(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send the remake."); }
    finally { setBusy(false); }
  }

  const selectedCount = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
  return <main className="remakePage">
    <header><p className="eyebrow">CORNER DELI · MANAGER</p><h1>Complaint remakes</h1><p>Send only the items that need to be remade. The new zero-charge order is linked to the original and enters the kitchen and delivery queues.</p></header>
    {printEnabled === false && <p className="remakeError" role="status"><strong>Kitchen printing is paused.</strong> Saving a remake here will not print a ticket. Dev test orders still appear in the kitchen and delivery queues.</p>}
    <section className="remakeSearch"><label htmlFor="remake-query">Find the original order</label><input id="remake-query" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Order number, customer, phone, or address" />
      {query.trim().length >= 2 && <div className="remakeMatches">{matches.length ? matches.slice(0, 40).map((match) => <button type="button" key={match.id} onClick={() => void selectOrder(match)} aria-current={order?.id === match.id ? "true" : undefined}><strong>#{match.display_number} · {match.customer_name}</strong><span>{dateLabel(match.created_at)} · {match.service_type.replaceAll("_", " ")} · {match.status.replaceAll("_", " ")}</span></button>) : <p>No matching orders from the last year.</p>}</div>}
    </section>
    {error && <p className="remakeError" role="alert">{error}</p>}
    {result && <section className="remakeResult" role="status"><h2>Remake order #{result.orderNumber} created</h2><p>The remake was saved and linked to original order #{order?.display_number}.</p><p>Kitchen print: <strong>{result.printStatus.replaceAll("_", " ")}</strong>{result.printMessage ? ` · ${result.printMessage}` : ""}</p><p>{result.printStatus === "succeeded" ? "The kitchen ticket was sent." : result.printMessage.includes("paused") ? "No kitchen ticket was printed." : "Check the kitchen printer or hardware settings before assuming the ticket arrived."}</p></section>}
    {order && !result && <form onSubmit={(event) => void submit(event)} className="remakeForm">
      <h2>Remake from order #{order.display_number}</h2><p>{order.customer_name} · {dateLabel(order.created_at)}</p>
      <fieldset><legend>Items to remake</legend>{(order.items || []).map((item) => { const available = Math.max(0, Number(item.quantity) - Number(item.cancelled_quantity || 0)); return <label className="remakeItem" key={item.id}><span><strong>{itemLabel(item)}</strong><small>{item.modifiers?.filter((modifier) => modifier.print_on_ticket !== false).map((modifier) => modifier.option_name_snapshot).join(" · ")}</small><small>{available} on original order</small></span><input type="number" aria-label={`Remake quantity for ${itemLabel(item)}`} min={0} max={available} step={1} value={quantities[item.id] || 0} onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: Math.max(0, Math.min(available, Number(event.target.value) || 0)) }))} /></label>; })}</fieldset>
      <label>Special item or instruction<textarea value={specialItem} maxLength={300} onChange={(event) => setSpecialItem(event.target.value)} placeholder="Example: Make 4 mozzarella sticks only" /></label>
      <label>What went wrong?<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: Mozzarella sticks were overcooked" /></label>
      <fieldset><legend>Fulfillment</legend><div className="remakeChoices"><label><input type="radio" checked={serviceType === "pickup"} onChange={() => setServiceType("pickup")} /> Pickup</label><label><input type="radio" checked={serviceType === "delivery"} onChange={() => setServiceType("delivery")} /> Delivery</label></div></fieldset>
      <div className="remakeGrid"><label>Customer name<input required value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label><label>Phone<input required type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label></div>
      {serviceType === "delivery" && <><div className="remakeGrid"><label>Delivery address<input required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Street, city, state, ZIP" /></label><label>Apartment or unit<input value={unit} onChange={(event) => setUnit(event.target.value)} /></label></div><label>Delivery instructions<input value={deliveryNotes} maxLength={300} onChange={(event) => setDeliveryNotes(event.target.value)} placeholder="Drop-off details for the driver" /></label></>}
      <fieldset><legend>When?</legend><div className="remakeChoices"><label><input type="radio" checked={timing === "asap"} onChange={() => setTiming("asap")} /> As soon as possible</label><label><input type="radio" checked={timing === "scheduled"} onChange={() => setTiming("scheduled")} /> Set a time</label></div>{timing === "scheduled" && <label>Pickup or delivery time (Eastern time)<input required type="datetime-local" value={scheduled} onChange={(event) => setScheduled(event.target.value)} /></label>}</fieldset>
      <section className="remakeReview"><h3>Review before sending</h3><p>{selectedCount ? `${selectedCount} selected item${selectedCount === 1 ? "" : "s"}` : "No original items selected"}{specialItem ? ` · Special: ${specialItem}` : ""}</p><p>{serviceType === "delivery" ? `Deliver to ${address || "an address"}${unit ? `, ${unit}` : ""}` : "Customer pickup"} · {timing === "asap" ? "ASAP" : scheduled ? `${scheduled.replace("T", " ")} ET` : "Choose a time"}</p><strong>No customer charge</strong></section>
      <button className="remakeSubmit" disabled={busy || (!selectedCount && !specialItem.trim()) || !reason.trim() || (timing === "scheduled" && !scheduled)}>{busy ? "SAVING…" : printEnabled === false ? "SAVE REMAKE · NO PRINT" : "SAVE REMAKE"}</button>
    </form>}
  </main>;
}
