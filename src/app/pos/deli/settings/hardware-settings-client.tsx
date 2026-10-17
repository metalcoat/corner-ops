"use client";
// Printers & devices: what each printer prints, which register uses which
// printer and cash drawer, card terminals, and the print history — in plain
// language, one card per thing.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type DeviceConfig = {
  host?: string;
  port?: number;
  ticketTextSize?: string;
  ticketHeaderSize?: string;
  tillKey?: string;
  cashDrawerEnabled?: boolean;
  receiptEnabled?: boolean;
  mxTerminalId?: string;
  labelLanguage?: "zpl" | "tspl" | "escpos";
  labelWidthMm?: number;
  labelHeightMm?: number;
  labelCategoryIds?: string[];
};
type Device = {
  id: string;
  name: string;
  device_key: string;
  location_id: string;
  device_type: "printer" | "payment_terminal" | "barcode_scanner";
  role: "receipt_printer" | "kitchen_printer" | "label_printer" | "payment_terminal" | "barcode_scanner";
  adapter_key: string;
  adapter_config?: DeviceConfig;
  active: boolean;
  effective_status: string;
  status_message: string;
};
type Job = { id: string; purpose: string; status: string; retry_count: number; device_name?: string; error_message: string; is_reprint: boolean; queued_at?: string };
type Station = {
  id: string;
  name: string;
  station_key: string;
  station_mode: "payment" | "order_taker";
  phone_card_payments_enabled: boolean;
  customer_display_enabled: boolean;
  shared_register_key: string;
  receipt_printer_id?: string | null;
  payment_terminal_id?: string | null;
  gift_card_reader_id?: string | null;
};
type TerminalReview = { id: string; order_id: string; display_number: string; amount_cents: number; provider_transaction_reference: string; status_message: string; created_at: string };
type Dashboard = {
  locations: Array<{ id: string; name: string }>;
  devices: Device[];
  jobs: Job[];
  paymentStations: Station[];
  categories: Array<{ id: string; name: string }>;
  kitchenPrinterIds: string[];
  printSettings: { externalKitchenAutoPrint: boolean };
};
type Provider = { provider: string; label: string; configured: boolean; onlineCheckoutEnabled: boolean; terminalCheckoutEnabled: boolean; sandbox: boolean; missing: string[] };

type PrinterKind = "receipt_printer" | "kitchen_printer" | "label_printer";
const KINDS: Array<{ value: PrinterKind; title: string; detail: string }> = [
  { value: "receipt_printer", title: "Receipts", detail: "Customer receipts at a register. A cash drawer can plug into it." },
  { value: "kitchen_printer", title: "Kitchen tickets", detail: "Order tickets for the line." },
  { value: "label_printer", title: "Food labels", detail: "Sticker labels for each sub and pizza." },
];
const LANGUAGES = [
  { value: "zpl", label: "ZPL — Volcora V-LBPTZ, Zebra and most Ethernet label printers" },
  { value: "tspl", label: "TSPL — Rollo, Munbyn, Xprinter, TSC" },
  { value: "escpos", label: "ESC/POS — Epson TM-L90 and receipt-style label printers" },
] as const;
const LABEL_SIZES = [
  { label: "4 × 2 in", w: 101, h: 51 },
  { label: "4 × 3 in", w: 101, h: 76 },
  { label: "3 × 2 in", w: 76, h: 51 },
  { label: "2.25 × 1.25 in", w: 57, h: 32 },
  { label: "4 × 6 in (shipping)", w: 101, h: 152 },
];
const kindTitle = (role: string) => (role === "receipt_printer" ? "Receipts" : role === "kitchen_printer" ? "Kitchen tickets" : role === "label_printer" ? "Food labels" : role === "payment_terminal" ? "Card terminal" : "Card swiper / scanner");
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "device";
const STATION_KEY = "corner-ops-station-key";

type PrinterForm = {
  id: string;
  key: string;
  kind: PrinterKind;
  name: string;
  host: string;
  port: number;
  drawer: boolean;
  receipts: boolean;
  textSize: string;
  headerSize: string;
  tillKey: string;
  language: "zpl" | "tspl" | "escpos";
  width: number;
  height: number;
  categories: string[];
};
const blankPrinter = (kind: PrinterKind): PrinterForm => ({ id: "", key: "", kind, name: "", host: "", port: 9100, drawer: false, receipts: false, textSize: "normal", headerSize: "large", tillKey: "", language: "zpl", width: 101, height: 51, categories: [] });
type StationForm = { id: string; key: string; name: string; payment: boolean; printerId: string; terminalId: string; readerId: string; display: boolean; phonePayments: boolean; registerKey: string; originalPrinterId: string };
const blankStation = (): StationForm => ({ id: "", key: "", name: "", payment: false, printerId: "", terminalId: "", readerId: "", display: false, phonePayments: true, registerKey: "", originalPrinterId: "" });
type OtherForm = { id: string; key: string; type: "payment_terminal" | "barcode_scanner"; name: string; mxTerminalId: string };

function StatusPill({ status }: { status: string }) {
  const label = status === "online" ? "Online" : status === "offline" ? "Offline" : "Not checked";
  return <span className={`hwStatus ${status}`}>{label}</span>;
}

export default function HardwareSettingsClient() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "good" | "bad" } | null>(null);
  const [busy, setBusy] = useState("");
  const [printer, setPrinter] = useState<PrinterForm | null>(null);
  const [station, setStation] = useState<StationForm | null>(null);
  const [other, setOther] = useState<OtherForm | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [mxTerminals, setMxTerminals] = useState<Array<{ id: string; name: string; providerKey: string; enabled: boolean }>>([]);
  const [reviews, setReviews] = useState<TerminalReview[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [thisTablet, setThisTablet] = useState("");
  const [locationName, setLocationName] = useState("");
  const [screens, setScreens] = useState<Array<{ id: string; kind: string; name: string; signed_in_by: string; last_seen_at: string }>>([]);

  async function load() {
    const [response, paymentResponse, reviewResponse] = await Promise.all([
      fetch("/api/ordering/settings/hardware", { cache: "no-store" }),
      fetch("/api/ordering/payments/status", { cache: "no-store" }),
      fetch("/api/ordering/payments/mx-terminal-review", { cache: "no-store" }),
    ]);
    const [body, paymentBody, reviewBody] = await Promise.all([response.json(), paymentResponse.json().catch(() => null), reviewResponse.json().catch(() => ({}))]);
    if (!response.ok) throw new Error(body.error || "Could not load printers and devices.");
    setData(body);
    if (paymentResponse.ok) setProvider(paymentBody);
    if (reviewResponse.ok) setReviews(Array.isArray(reviewBody.sales) ? reviewBody.sales : []);
    const screenResponse = await fetch("/api/pos/screen?list=1", { cache: "no-store" }).catch(() => null);
    if (screenResponse?.ok) setScreens((await screenResponse.json()).screens || []);
  }
  useEffect(() => {
    try {
      setThisTablet(localStorage.getItem(STATION_KEY) || "");
    } catch {}
    void load().catch((error) => setMessage({ text: error.message, tone: "bad" }));
  }, []);

  async function act(body: Record<string, unknown>, success: string) {
    setMessage(null);
    setBusy(String(body.action) + String(body.id || ""));
    try {
      const response = await fetch("/api/ordering/settings/hardware", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "That didn't work.");
      await load();
      setMessage({ text: success, tone: "good" });
      return true;
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "That didn't work.", tone: "bad" });
      return false;
    } finally {
      setBusy("");
    }
  }

  const devices = useMemo(() => data?.devices ?? [], [data]);
  const printers = devices.filter((device) => device.device_type === "printer");
  const receiptCapable = printers.filter((device) => device.role === "receipt_printer" || (device.role === "kitchen_printer" && device.adapter_config?.receiptEnabled));
  const kitchenPrinters = printers.filter((device) => device.role === "kitchen_printer");
  const labelPrinters = printers.filter((device) => device.role === "label_printer");
  const terminals = devices.filter((device) => device.role === "payment_terminal");
  const readers = devices.filter((device) => device.role === "barcode_scanner");
  const stations = data?.paymentStations ?? [];
  const categoryName = new Map((data?.categories ?? []).map((row) => [row.id, row.name]));
  const usedBy = (deviceId: string) => stations.filter((row) => row.receipt_printer_id === deviceId || row.payment_terminal_id === deviceId || row.gift_card_reader_id === deviceId).map((row) => row.name);
  const deviceName = (id?: string | null) => devices.find((device) => device.id === id)?.name;

  function editPrinter(device: Device) {
    const config = device.adapter_config || {};
    setPrinter({
      id: device.id,
      key: device.device_key,
      kind: device.role as PrinterKind,
      name: device.name,
      host: config.host || "",
      port: Number(config.port || 9100),
      drawer: Boolean(config.cashDrawerEnabled),
      receipts: Boolean(config.receiptEnabled && device.role === "kitchen_printer"),
      textSize: config.ticketTextSize || "normal",
      headerSize: config.ticketHeaderSize || "large",
      tillKey: config.tillKey || "",
      language: config.labelLanguage || "zpl",
      width: Number(config.labelWidthMm || 101),
      height: Number(config.labelHeightMm || 51),
      categories: config.labelCategoryIds || [],
    });
  }

  async function savePrinter(form: PrinterForm) {
    const receiptsHere = form.kind === "receipt_printer" || (form.kind === "kitchen_printer" && form.receipts);
    const saved = await act(
      {
        action: "save_device",
        id: form.id || undefined,
        name: form.name.trim(),
        deviceKey: form.key || `${slug(form.name)}-${Date.now().toString(36).slice(-4)}`,
        deviceType: "printer",
        role: form.kind,
        adapterKey: "network-printer",
        locationId: devices.find((device) => device.id === form.id)?.location_id || data?.locations[0]?.id || "",
        adapterConfig: {
          host: form.host.trim(),
          port: form.port,
          ticketTextSize: form.textSize,
          ticketHeaderSize: form.headerSize,
          receiptEnabled: receiptsHere,
          cashDrawerEnabled: receiptsHere && form.drawer,
          tillKey: receiptsHere ? form.tillKey || form.name.trim() : "",
          ...(form.kind === "label_printer" ? { labelLanguage: form.language, labelWidthMm: form.width, labelHeightMm: form.height, labelCategoryIds: form.categories } : {}),
        },
      },
      form.id ? `${form.name} saved.` : `${form.name} added. Tap “Test print” to make sure it works.`,
    );
    if (saved) setPrinter(null);
  }

  async function saveStation(form: StationForm) {
    const saved = await act(
      {
        action: "save_payment_station",
        name: form.name.trim(),
        stationKey: form.key || slug(form.name),
        stationMode: form.payment ? "payment" : "order_taker",
        receiptPrinterId: form.printerId || null,
        paymentTerminalId: form.payment ? form.terminalId || null : null,
        giftCardReaderId: form.payment ? form.readerId || null : null,
        phoneCardPaymentsEnabled: form.phonePayments,
        customerDisplayEnabled: form.display,
        // Registers sharing a printer share its cash drawer; the server works the key out from the printer.
        sharedRegisterKey: form.printerId === form.originalPrinterId ? form.registerKey : "",
      },
      `${form.name} saved.`,
    );
    if (saved) setStation(null);
  }

  async function saveOther(form: OtherForm) {
    const saved = await act(
      {
        action: "save_device",
        id: form.id || undefined,
        name: form.name.trim(),
        deviceKey: form.key || `${slug(form.name)}-${Date.now().toString(36).slice(-4)}`,
        deviceType: form.type,
        role: form.type,
        adapterKey: form.type === "payment_terminal" ? "mx-terminal" : "keyboard-wedge",
        locationId: devices.find((device) => device.id === form.id)?.location_id || data?.locations[0]?.id || "",
        adapterConfig: form.type === "payment_terminal" ? { mxTerminalId: form.mxTerminalId.trim() } : {},
      },
      `${form.name} saved.`,
    );
    if (saved) setOther(null);
  }

  async function findTerminals() {
    setBusy("provider");
    setMessage(null);
    try {
      const response = await fetch("/api/ordering/payments/status", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not reach the card processor.");
      setMxTerminals(Array.isArray(body.terminals) ? body.terminals : []);
      setMessage({
        text: `${provider?.label || "Card processor"} connection works.${body.terminalError ? ` Terminal list failed: ${body.terminalError}` : ` ${body.terminals?.length || 0} terminal(s) found.`}`,
        tone: body.terminalError ? "bad" : "good",
      });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not reach the card processor.", tone: "bad" });
    } finally {
      setBusy("");
    }
  }

  if (!data)
    return (
      <section className="posSettingsCard hwPage">
        <h2>Printers &amp; devices</h2>
        <p>{message?.text || "Loading…"}</p>
      </section>
    );

  const checklist = [
    { ok: receiptCapable.length > 0, title: "Receipt printer", hint: receiptCapable.length ? receiptCapable.map((row) => row.name).join(", ") : "Add a printer that prints receipts" },
    { ok: kitchenPrinters.length > 0, title: "Kitchen printer", hint: kitchenPrinters.length ? kitchenPrinters.filter((row) => data.kitchenPrinterIds.includes(row.id)).map((row) => row.name).join(", ") : "Add a printer for kitchen tickets" },
    { ok: labelPrinters.length > 0, title: "Label printer", hint: labelPrinters.length ? labelPrinters.map((row) => row.name).join(", ") : "Optional: sticker labels for subs & pizzas" },
    { ok: printers.some((row) => row.adapter_config?.cashDrawerEnabled), title: "Cash drawer", hint: printers.filter((row) => row.adapter_config?.cashDrawerEnabled).map((row) => `on ${row.name}`).join(", ") || "Tick “cash drawer plugged in” on a receipt printer" },
    { ok: terminals.length > 0, title: "Card terminal", hint: terminals.length ? terminals.map((row) => row.name).join(", ") : "Add the Dejavoo terminal once Dharma sets it up" },
    { ok: stations.length > 0, title: "Registers", hint: stations.length ? stations.map((row) => row.name).join(", ") : "Add one per POS tablet" },
  ];

  return (
    <section className="posSettingsCard hwPage">
      <header className="hwHeader">
        <div>
          <h2>Printers &amp; devices</h2>
          <p>Set up each printer once, then tell each register which printer and cash drawer it uses.</p>
        </div>
        <Link className="hwLinkButton" href="/setup">Set up a tablet →</Link>
      </header>
      {message && (
        <p className={`hwMessage ${message.tone}`} role="status">
          {message.text}
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss">×</button>
        </p>
      )}

      <div className="hwChecklist">
        {checklist.map((item) => (
          <div key={item.title} className={item.ok ? "ok" : ""}>
            <b>{item.ok ? "✓" : "○"}</b>
            <span>
              <strong>{item.title}</strong>
              <small>{item.hint}</small>
            </span>
          </div>
        ))}
      </div>

      {reviews.length > 0 && (
        <section className="hwSection hwAlert">
          <h3>Card terminal charges to review</h3>
          <p>The terminal charged these cards, but the POS could not put the charge on the order. Refund or record each one in MX Merchant, then mark it resolved. Until then the order cannot take another payment.</p>
          {reviews.map((sale) => (
            <article key={sale.id} className="hwCard">
              <div>
                <strong>Order #{sale.display_number} · ${(Number(sale.amount_cents) / 100).toFixed(2)}</strong>
                <small>
                  {new Date(sale.created_at).toLocaleString()}
                  {sale.provider_transaction_reference && <> · MX payment <code>{sale.provider_transaction_reference}</code></>}
                </small>
                <small>{sale.status_message}</small>
              </div>
              <label className="hwField">
                What was done in MX
                <input value={reviewNotes[sale.id] || ""} placeholder="Refunded in MX" onChange={(e) => setReviewNotes((notes) => ({ ...notes, [sale.id]: e.target.value }))} />
              </label>
              <button
                type="button"
                disabled={(reviewNotes[sale.id] || "").trim().length < 3}
                onClick={() => {
                  setMessage(null);
                  void fetch("/api/ordering/payments/mx-terminal-review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sale.id, note: reviewNotes[sale.id] }) })
                    .then(async (response) => {
                      const body = await response.json();
                      if (!response.ok) throw new Error(body.error || "Could not resolve the charge.");
                      setReviews(body.sales || []);
                      setMessage({ text: `Order #${sale.display_number}'s terminal charge marked resolved.`, tone: "good" });
                    })
                    .catch((error) => setMessage({ text: error instanceof Error ? error.message : "Could not resolve the charge.", tone: "bad" }));
                }}
              >
                MARK RESOLVED
              </button>
            </article>
          ))}
        </section>
      )}

      {/* ---------------- Printers ---------------- */}
      <section className="hwSection">
        <div className="hwSectionHead">
          <h3>Printers</h3>
          {!printer && (
            <button type="button" onClick={() => setPrinter(blankPrinter("receipt_printer"))}>
              + Add printer
            </button>
          )}
        </div>
        {printer && (
          <form
            className="hwForm"
            onSubmit={(event) => {
              event.preventDefault();
              void savePrinter(printer);
            }}
          >
            <h4>{printer.id ? `Edit ${printer.name || "printer"}` : "Add a printer"}</h4>
            <fieldset className="hwKinds">
              <legend>What will it print?</legend>
              {KINDS.map((kind) => (
                <label key={kind.value} className={printer.kind === kind.value ? "selected" : ""}>
                  <input type="radio" name="kind" checked={printer.kind === kind.value} onChange={() => setPrinter({ ...printer, kind: kind.value })} />
                  <strong>{kind.title}</strong>
                  <small>{kind.detail}</small>
                </label>
              ))}
            </fieldset>
            <div className="hwFields">
              <label className="hwField">
                Name
                <input required value={printer.name} placeholder={printer.kind === "receipt_printer" ? "Front counter printer" : printer.kind === "kitchen_printer" ? "Kitchen printer" : "Sub station labels"} onChange={(e) => setPrinter({ ...printer, name: e.target.value })} />
              </label>
              <label className="hwField">
                IP address
                <input required inputMode="decimal" autoComplete="off" value={printer.host} placeholder="192.168.1.50" onChange={(e) => setPrinter({ ...printer, host: e.target.value })} />
                <small>Hold the printer&apos;s FEED button while turning it on to print its settings page; the IP address is on it.</small>
              </label>
            </div>
            {printer.kind === "receipt_printer" && (
              <label className="hwCheck">
                <input type="checkbox" checked={printer.drawer} onChange={(e) => setPrinter({ ...printer, drawer: e.target.checked })} />
                <span>
                  <strong>A cash drawer is plugged into this printer</strong>
                  <small>The drawer opens when a cash sale prints its receipt.</small>
                </span>
              </label>
            )}
            {printer.kind === "kitchen_printer" && (
              <>
                <label className="hwCheck">
                  <input type="checkbox" checked={printer.receipts} onChange={(e) => setPrinter({ ...printer, receipts: e.target.checked })} />
                  <span>
                    <strong>Also print customer receipts here</strong>
                    <small>For a back register that shares the kitchen printer.</small>
                  </span>
                </label>
                {printer.receipts && (
                  <label className="hwCheck">
                    <input type="checkbox" checked={printer.drawer} onChange={(e) => setPrinter({ ...printer, drawer: e.target.checked })} />
                    <span>
                      <strong>A cash drawer is plugged into this printer</strong>
                    </span>
                  </label>
                )}
              </>
            )}
            {printer.kind === "label_printer" && (
              <div className="hwLabelOptions">
                <label className="hwField">
                  Printer language
                  <select value={printer.language} onChange={(e) => setPrinter({ ...printer, language: e.target.value as PrinterForm["language"] })}>
                    {LANGUAGES.map((language) => (
                      <option key={language.value} value={language.value}>{language.label}</option>
                    ))}
                  </select>
                  <small>Not sure? Check the model on the printer, or try a test print in each until one prints cleanly.</small>
                </label>
                <div className="hwField">
                  Label size
                  <div className="hwChips">
                    {LABEL_SIZES.map((size) => (
                      <button type="button" key={size.label} className={printer.width === size.w && printer.height === size.h ? "selected" : ""} onClick={() => setPrinter({ ...printer, width: size.w, height: size.h })}>
                        {size.label}
                      </button>
                    ))}
                  </div>
                  <small>
                    Custom: <input className="hwTiny" type="number" min={25} max={120} value={printer.width} onChange={(e) => setPrinter({ ...printer, width: Number(e.target.value) })} /> ×{" "}
                    <input className="hwTiny" type="number" min={15} max={200} value={printer.height} onChange={(e) => setPrinter({ ...printer, height: Number(e.target.value) })} /> mm
                  </small>
                </div>
                <div className="hwField">
                  Print labels for
                  <small>{printer.categories.length ? "Only the menu sections ticked below." : "Nothing ticked: anything that looks like a sub or pizza (subs, wraps, pizza, calzones…) gets a label."}</small>
                  <div className="hwChips">
                    {(data.categories || []).map((category) => {
                      const on = printer.categories.includes(category.id);
                      return (
                        <button type="button" key={category.id} className={on ? "selected" : ""} onClick={() => setPrinter({ ...printer, categories: on ? printer.categories.filter((id) => id !== category.id) : [...printer.categories, category.id] })}>
                          {on ? "✓ " : ""}
                          {category.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <details className="hwAdvanced">
              <summary>Advanced</summary>
              <div className="hwFields">
                <label className="hwField">
                  Port
                  <input type="number" min={1} max={65535} value={printer.port} onChange={(e) => setPrinter({ ...printer, port: Number(e.target.value) })} />
                </label>
                {printer.kind !== "label_printer" && (
                  <>
                    <label className="hwField">
                      Ticket text size
                      <select value={printer.textSize} onChange={(e) => setPrinter({ ...printer, textSize: e.target.value })}>
                        <option value="normal">Normal</option>
                        <option value="large">Large</option>
                        <option value="extra_large">Extra large</option>
                      </select>
                    </label>
                    <label className="hwField">
                      Ticket header size
                      <select value={printer.headerSize} onChange={(e) => setPrinter({ ...printer, headerSize: e.target.value })}>
                        <option value="normal">Normal</option>
                        <option value="large">Large</option>
                        <option value="extra_large">Extra large</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
            </details>
            <div className="hwFormActions">
              <button type="submit" disabled={!printer.name.trim() || !printer.host.trim() || busy.startsWith("save_device")}>
                {printer.id ? "Save printer" : "Add printer"}
              </button>
              <button type="button" className="hwSecondary" onClick={() => setPrinter(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {printers.length === 0 && !printer && <p className="hwEmpty">No printers yet. Add your receipt printer first, then the kitchen printer.</p>}
        <div className="hwCards">
          {printers.map((device) => {
            const config = device.adapter_config || {};
            const users = usedBy(device.id);
            return (
              <article key={device.id} className="hwCard">
                <div className="hwCardTop">
                  <span className="hwKind">{kindTitle(device.role)}</span>
                  <StatusPill status={device.effective_status} />
                </div>
                <strong className="hwCardName">{device.name}</strong>
                <small>{device.adapter_key === "network-printer" ? `${config.host}${config.port && config.port !== 9100 ? `:${config.port}` : ""}` : "Connection not set — edit to add its IP address"}</small>
                <div className="hwTags">
                  {config.cashDrawerEnabled && <span>💵 Cash drawer attached</span>}
                  {device.role === "kitchen_printer" && config.receiptEnabled && <span>Also prints receipts</span>}
                  {device.role === "kitchen_printer" && data.kitchenPrinterIds.includes(device.id) && <span>Prints kitchen tickets</span>}
                  {device.role === "label_printer" && (
                    <span>
                      {config.labelCategoryIds?.length ? `Labels: ${config.labelCategoryIds.map((id) => categoryName.get(id) || "?").join(", ")}` : "Labels: subs & pizzas"} · {(config.labelLanguage || "zpl").toUpperCase()}
                    </span>
                  )}
                  {users.length > 0 && <span>Used by {users.join(", ")}</span>}
                </div>
                {device.effective_status === "offline" && device.status_message && <small className="hwProblem">{device.status_message}</small>}
                <div className="hwActions">
                  <button type="button" disabled={Boolean(busy)} onClick={() => void act({ action: "test_print", id: device.id }, device.role === "label_printer" ? "Test label sent." : "Test page sent.")}>
                    Test print
                  </button>
                  {config.cashDrawerEnabled && (
                    <button type="button" disabled={Boolean(busy)} onClick={() => void act({ action: "test_cash_drawer", id: device.id }, "Drawer open signal sent.")}>
                      Open drawer
                    </button>
                  )}
                  <button type="button" className="hwSecondary" disabled={Boolean(busy)} onClick={() => void act({ action: "probe_device", id: device.id }, "Connection checked.")}>
                    Check
                  </button>
                  <button type="button" className="hwSecondary" onClick={() => editPrinter(device)}>
                    Edit
                  </button>
                  <button type="button" className="hwDanger" onClick={() => confirm(`Remove ${device.name}?${users.length ? ` ${users.join(", ")} will stop printing to it.` : ""}`) && void act({ action: "deactivate_device", id: device.id }, `${device.name} removed.`)}>
                    Remove
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* ---------------- Kitchen tickets ---------------- */}
      <section className="hwSection">
        <h3>Kitchen tickets</h3>
        <div className="hwRow">
          <div className="hwField">
            Kitchen tickets print on
            {kitchenPrinters.length ? (
              <div className="hwChips">
                {kitchenPrinters.map((device) => {
                  const on = data.kitchenPrinterIds.includes(device.id);
                  const next = on ? data.kitchenPrinterIds.filter((id) => id !== device.id) : [...data.kitchenPrinterIds, device.id];
                  return (
                    <button
                      type="button"
                      key={device.id}
                      className={on ? "selected" : ""}
                      disabled={Boolean(busy) || (on && next.length === 0)}
                      title={on && next.length === 0 ? "At least one kitchen printer has to print tickets" : undefined}
                      onClick={() => void act({ action: "set_kitchen_printers", printerIds: next }, "Kitchen printers saved.")}
                    >
                      {on ? "✓ " : ""}
                      {device.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <small>Add a kitchen printer above first.</small>
            )}
            <small>Every ticked printer prints the same full ticket.</small>
          </div>
          <div className="hwToggle">
            <span>
              <strong>Print new orders automatically</strong>
              <small>{data.printSettings.externalKitchenAutoPrint ? "On — POS, kiosk, online and phone orders print right away." : "Paused — orders still show on the kitchen screen; nothing prints until you turn this on."}</small>
            </span>
            <button
              type="button"
              className={data.printSettings.externalKitchenAutoPrint ? "rocker on" : "rocker"}
              role="switch"
              aria-checked={data.printSettings.externalKitchenAutoPrint}
              onClick={() => void act({ action: "save_print_settings", externalKitchenAutoPrint: !data.printSettings.externalKitchenAutoPrint }, data.printSettings.externalKitchenAutoPrint ? "Automatic kitchen printing paused." : "Automatic kitchen printing turned on.")}
            >
              <span aria-hidden="true" />
              {data.printSettings.externalKitchenAutoPrint ? "ON" : "PAUSED"}
            </button>
          </div>
        </div>
      </section>

      {/* ---------------- Registers ---------------- */}
      <section className="hwSection">
        <div className="hwSectionHead">
          <h3>Registers</h3>
          {!station && (
            <button type="button" onClick={() => setStation(blankStation())}>
              + Add register
            </button>
          )}
        </div>
        <p className="hwIntro">One per POS tablet. Each register says which printer gives its receipts (and cash drawer), and whether it takes payments.</p>
        {station && (
          <form
            className="hwForm"
            onSubmit={(event) => {
              event.preventDefault();
              void saveStation(station);
            }}
          >
            <h4>{station.id ? `Edit ${station.name}` : "Add a register"}</h4>
            <div className="hwFields">
              <label className="hwField">
                Name
                <input required value={station.name} placeholder="Front register" onChange={(e) => setStation({ ...station, name: e.target.value })} />
              </label>
              <label className="hwField">
                Receipts &amp; cash drawer
                <select value={station.printerId} onChange={(e) => setStation({ ...station, printerId: e.target.value })}>
                  <option value="">No printer (order taking only)</option>
                  {receiptCapable.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                      {device.adapter_config?.cashDrawerEnabled ? " — has cash drawer" : ""}
                    </option>
                  ))}
                </select>
                {receiptCapable.length === 0 && <small>Add a receipt printer above first.</small>}
              </label>
            </div>
            <fieldset className="hwKinds two">
              <legend>Does this register take payments?</legend>
              <label className={!station.payment ? "selected" : ""}>
                <input type="radio" checked={!station.payment} onChange={() => setStation({ ...station, payment: false })} />
                <strong>No — takes orders</strong>
                <small>Orders are sent to the payment register to pay.</small>
              </label>
              <label className={station.payment ? "selected" : ""}>
                <input type="radio" checked={station.payment} onChange={() => setStation({ ...station, payment: true })} />
                <strong>Yes — payment register</strong>
                <small>Has the card terminal and cash drawer. Only one register can be the payment register.</small>
              </label>
            </fieldset>
            {station.payment && (
              <div className="hwFields">
                <label className="hwField">
                  Card terminal
                  <select value={station.terminalId} onChange={(e) => setStation({ ...station, terminalId: e.target.value })}>
                    <option value="">None yet</option>
                    {terminals.map((device) => (
                      <option key={device.id} value={device.id}>{device.name}</option>
                    ))}
                  </select>
                </label>
                <label className="hwField">
                  Gift card swiper
                  <select value={station.readerId} onChange={(e) => setStation({ ...station, readerId: e.target.value })}>
                    <option value="">None</option>
                    {readers.map((device) => (
                      <option key={device.id} value={device.id}>{device.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <label className="hwCheck">
              <input type="checkbox" checked={station.display} onChange={(e) => setStation({ ...station, display: e.target.checked })} />
              <span>
                <strong>Has a customer display</strong>
                <small>A screen facing the customer for totals, tips and receipts.</small>
              </span>
            </label>
            <label className="hwCheck">
              <input type="checkbox" checked={station.phonePayments} onChange={(e) => setStation({ ...station, phonePayments: e.target.checked })} />
              <span>
                <strong>Can take card payments over the phone</strong>
                <small>Type in a card number for phone orders.</small>
              </span>
            </label>
            <div className="hwFormActions">
              <button type="submit" disabled={!station.name.trim() || (station.payment && !station.printerId) || busy.startsWith("save_payment_station")}>
                {station.id ? "Save register" : "Add register"}
              </button>
              <button type="button" className="hwSecondary" onClick={() => setStation(null)}>
                Cancel
              </button>
              {station.payment && !station.printerId && <small className="hwProblem">A payment register needs a receipt printer.</small>}
            </div>
          </form>
        )}
        {stations.length === 0 && !station && <p className="hwEmpty">No registers yet. Add one for each POS tablet.</p>}
        <div className="hwCards">
          {stations.map((row) => {
            const receiptPrinter = devices.find((device) => device.id === row.receipt_printer_id);
            const sharing = stations.filter((other) => other.id !== row.id && other.shared_register_key && other.shared_register_key === row.shared_register_key).map((other) => other.name);
            return (
              <article key={row.id} className={`hwCard${thisTablet === row.station_key ? " thisOne" : ""}`}>
                <div className="hwCardTop">
                  <span className="hwKind">{row.station_mode === "payment" ? "Payment register" : "Order taking"}</span>
                  {thisTablet === row.station_key && <span className="hwStatus online">This tablet</span>}
                </div>
                <strong className="hwCardName">{row.name}</strong>
                <ul className="hwFacts">
                  <li>
                    Receipts: <b>{receiptPrinter?.name || "none"}</b>
                    {receiptPrinter?.adapter_config?.cashDrawerEnabled ? " · 💵 cash drawer" : ""}
                  </li>
                  {row.station_mode === "payment" && (
                    <li>
                      Card terminal: <b>{deviceName(row.payment_terminal_id) || "none yet"}</b>
                    </li>
                  )}
                  {row.gift_card_reader_id && (
                    <li>
                      Gift card swiper: <b>{deviceName(row.gift_card_reader_id)}</b>
                    </li>
                  )}
                  <li>Customer display: {row.customer_display_enabled ? "yes" : "no"} · Phone card payments: {row.phone_card_payments_enabled ? "yes" : "no"}</li>
                  {sharing.length > 0 && <li>Shares its cash drawer with {sharing.join(", ")}</li>}
                </ul>
                <div className="hwActions">
                  <button
                    type="button"
                    className="hwSecondary"
                    onClick={() =>
                      setStation({
                        id: row.id,
                        key: row.station_key,
                        name: row.name,
                        payment: row.station_mode === "payment",
                        printerId: row.receipt_printer_id || "",
                        terminalId: row.payment_terminal_id || "",
                        readerId: row.gift_card_reader_id || "",
                        display: row.customer_display_enabled,
                        phonePayments: row.phone_card_payments_enabled,
                        registerKey: row.shared_register_key || "",
                        originalPrinterId: row.receipt_printer_id || "",
                      })
                    }
                  >
                    Edit
                  </button>
                  {thisTablet !== row.station_key && (
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          localStorage.setItem(STATION_KEY, row.station_key);
                        } catch {}
                        setThisTablet(row.station_key);
                        setMessage({ text: `This tablet is now ${row.name}. Reload the POS to use it.`, tone: "good" });
                      }}
                    >
                      Use on this tablet
                    </button>
                  )}
                  {row.customer_display_enabled && (
                    <a className="hwLinkButton small" target="_blank" rel="noreferrer" href={`/display/deli?station=${encodeURIComponent(row.station_key)}`}>
                      Open customer display
                    </a>
                  )}
                  <button type="button" className="hwDanger" onClick={() => confirm(`Remove ${row.name}?`) && void act({ action: "remove_station", id: row.id }, `${row.name} removed.`)}>
                    Remove
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* ---------------- Card terminals & scanners ---------------- */}
      <section className="hwSection">
        <div className="hwSectionHead">
          <h3>Card terminals &amp; swipers</h3>
          {!other && (
            <div className="hwActions">
              <button type="button" onClick={() => setOther({ id: "", key: "", type: "payment_terminal", name: "", mxTerminalId: "" })}>
                + Add card terminal
              </button>
              <button type="button" className="hwSecondary" onClick={() => setOther({ id: "", key: "", type: "barcode_scanner", name: "", mxTerminalId: "" })}>
                + Add swiper / scanner
              </button>
            </div>
          )}
        </div>
        <div className="hwProvider">
          <span className={`hwStatus ${provider?.configured ? "online" : "offline"}`}>{provider?.configured ? "Connected" : "Not set up"}</span>
          <span>
            <strong>{provider?.label || "Card processor"}</strong>
            {provider?.sandbox ? " · TEST MODE" : ""}
            <small>
              Online checkout {provider?.onlineCheckoutEnabled ? "ready" : "not ready"} · Terminal {provider?.terminalCheckoutEnabled ? "ready" : "not ready"}
              {provider?.missing?.length ? ` · Missing: ${provider.missing.join(", ")}` : ""}
            </small>
          </span>
          <button type="button" className="hwSecondary" disabled={!provider?.configured || busy === "provider"} onClick={() => void findTerminals()}>
            {busy === "provider" ? "Checking…" : "Test connection"}
          </button>
        </div>
        {other && (
          <form
            className="hwForm"
            onSubmit={(event) => {
              event.preventDefault();
              void saveOther(other);
            }}
          >
            <h4>{other.type === "payment_terminal" ? (other.id ? "Edit card terminal" : "Add a card terminal") : other.id ? "Edit swiper / scanner" : "Add a gift card swiper or barcode scanner"}</h4>
            <div className="hwFields">
              <label className="hwField">
                Name
                <input required value={other.name} placeholder={other.type === "payment_terminal" ? "Front Dejavoo Z6" : "Front swiper"} onChange={(e) => setOther({ ...other, name: e.target.value })} />
              </label>
              {other.type === "payment_terminal" && (
                <label className="hwField">
                  MX terminal ID
                  <input required autoComplete="off" value={other.mxTerminalId} placeholder="Tap “Find my terminals” below" onChange={(e) => setOther({ ...other, mxTerminalId: e.target.value })} />
                </label>
              )}
            </div>
            {other.type === "payment_terminal" && (
              <div className="hwTerminalPicker">
                <button type="button" className="hwSecondary" disabled={!provider?.configured || busy === "provider"} onClick={() => void findTerminals()}>
                  Find my terminals
                </button>
                {mxTerminals.map((terminal) => (
                  <button type="button" key={terminal.id} className={other.mxTerminalId === terminal.id ? "selected" : ""} onClick={() => setOther({ ...other, mxTerminalId: terminal.id, name: other.name || terminal.name })}>
                    {terminal.name || "Unnamed terminal"}
                    {terminal.enabled ? "" : " (disabled)"}
                    <small>{terminal.id}</small>
                  </button>
                ))}
              </div>
            )}
            {other.type === "barcode_scanner" && <p className="hwIntro">Plug the swiper or scanner into the tablet (USB or Bluetooth). It types like a keyboard, so there is nothing else to set up.</p>}
            <div className="hwFormActions">
              <button type="submit" disabled={!other.name.trim() || (other.type === "payment_terminal" && !other.mxTerminalId.trim())}>
                Save
              </button>
              <button type="button" className="hwSecondary" onClick={() => setOther(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="hwCards">
          {[...terminals, ...readers].map((device) => (
            <article key={device.id} className="hwCard">
              <div className="hwCardTop">
                <span className="hwKind">{kindTitle(device.role)}</span>
                {device.role === "payment_terminal" && <StatusPill status={device.effective_status} />}
              </div>
              <strong className="hwCardName">{device.name}</strong>
              {device.adapter_config?.mxTerminalId && <small><code>{device.adapter_config.mxTerminalId}</code></small>}
              {usedBy(device.id).length > 0 && <div className="hwTags"><span>Used by {usedBy(device.id).join(", ")}</span></div>}
              <div className="hwActions">
                {device.role === "payment_terminal" && (
                  <button type="button" className="hwSecondary" disabled={Boolean(busy)} onClick={() => void act({ action: "probe_device", id: device.id }, "Terminal checked.")}>
                    Check
                  </button>
                )}
                <button type="button" className="hwSecondary" onClick={() => setOther({ id: device.id, key: device.device_key, type: device.role as OtherForm["type"], name: device.name, mxTerminalId: device.adapter_config?.mxTerminalId || "" })}>
                  Edit
                </button>
                <button type="button" className="hwDanger" onClick={() => confirm(`Remove ${device.name}?`) && void act({ action: "deactivate_device", id: device.id }, `${device.name} removed.`)}>
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ---------------- Always-on screens ---------------- */}
      <section className="hwSection">
        <h3>Screens that stay signed in</h3>
        <p className="hwIntro">The status board monitor and label stations sign in once and never time out. Sign one out here if it moves or goes missing.</p>
        {screens.length === 0 ? (
          <p className="hwEmpty">None yet. Open the Dashboard or Labels from the /pos screen on that device and sign in once.</p>
        ) : (
          <ul className="hwJobs">
            {screens.map((screen) => (
              <li key={screen.id}>
                <span>
                  <strong>{screen.name}</strong> · {screen.kind === "board" ? "Status board" : "Label station"}
                  <small>
                    Signed in by {screen.signed_in_by} · last seen {new Date(screen.last_seen_at).toLocaleString()}
                  </small>
                </span>
                <button
                  type="button"
                  className="hwDanger"
                  onClick={() => {
                    if (!confirm(`Sign out ${screen.name}? It will ask for a PIN next time.`)) return;
                    void fetch(`/api/pos/screen?id=${encodeURIComponent(screen.id)}`, { method: "DELETE" }).then(async (response) => {
                      if (!response.ok) return setMessage({ text: "Could not sign that screen out.", tone: "bad" });
                      setScreens((rows) => rows.filter((row) => row.id !== screen.id));
                      setMessage({ text: `${screen.name} signed out.`, tone: "good" });
                    });
                  }}
                >
                  Sign out
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Print history ---------------- */}
      <details className="hwSection hwHistory">
        <summary>
          <h3>Print history</h3>
          <span>
            {data.jobs.filter((job) => ["failed", "not_configured"].includes(job.status)).length
              ? `${data.jobs.filter((job) => ["failed", "not_configured"].includes(job.status)).length} need attention`
              : "All recent prints went through"}
          </span>
        </summary>
        {data.jobs.length === 0 ? (
          <p className="hwEmpty">Nothing printed yet.</p>
        ) : (
          <ul className="hwJobs">
            {data.jobs.map((job) => (
              <li key={job.id} className={["failed", "not_configured"].includes(job.status) ? "bad" : ""}>
                <span>
                  <strong>{job.purpose === "kitchen_production" ? "Kitchen ticket" : job.purpose.replaceAll("_", " ")}</strong>
                  {job.is_reprint ? " (reprint)" : ""} · {job.device_name || "no printer"} ·{" "}
                  {job.status === "succeeded" ? "printed" : job.status === "not_configured" ? "no printer set up" : job.status.replaceAll("_", " ")}
                  {job.error_message && <small>{job.error_message}</small>}
                </span>
                <span className="hwActions">
                  {["failed", "not_configured"].includes(job.status) && (
                    <button type="button" onClick={() => void act({ action: "retry", jobId: job.id, reason: "Retried from Printers & devices" }, "Print retried.")}>
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="hwSecondary"
                    onClick={() => {
                      const reason = window.prompt("Why reprint? (for the record)");
                      if (reason) void act({ action: "reprint", jobId: job.id, reason }, "Reprint sent.");
                    }}
                  >
                    Reprint
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="hwSection hwAdvancedSection">
        <summary>
          <h3>Advanced: locations</h3>
          <span>Only needed if devices are spread across separate buildings.</span>
        </summary>
        <p className="hwIntro">Devices are placed in {data.locations.map((row) => row.name).join(", ") || "a default “Store” location, created automatically"}.</p>
        <div className="hwRow">
          <label className="hwField">
            New location name
            <input value={locationName} onChange={(e) => setLocationName(e.target.value)} />
          </label>
          <button type="button" disabled={!locationName.trim()} onClick={() => void act({ action: "save_location", name: locationName.trim(), locationKey: slug(locationName) }, "Location added.").then((ok) => ok && setLocationName(""))}>
            Add location
          </button>
        </div>
      </details>
    </section>
  );
}
