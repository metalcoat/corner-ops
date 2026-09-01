"use client";
import { useEffect, useState } from "react";
type Location = { id: string; name: string };
type Device = {
  id: string;
  name: string;
  device_key: string;
  location_id: string;
  device_type: string;
  role: string;
  adapter_key: string;
  adapter_config?: {
    host?: string;
    port?: number;
    ticketTextSize?: string;
    ticketHeaderSize?: string;
    tillKey?: string;
    cashDrawerEnabled?: boolean;
    receiptEnabled?: boolean;
  };
  active: boolean;
  effective_status: string;
  status_message: string;
};
type Job = {
  id: string;
  purpose: string;
  status: string;
  retry_count: number;
  device_name?: string;
  error_message: string;
  is_reprint: boolean;
};
type PaymentStation={id:string;name:string;station_key:string;station_mode:"payment"|"order_taker";phone_card_payments_enabled:boolean;customer_display_enabled:boolean;shared_register_key:string;receipt_printer_id?:string|null;payment_terminal_id?:string|null;gift_card_reader_id?:string|null;receipt_printer_name?:string|null;payment_terminal_name?:string|null;gift_card_reader_name?:string|null};
export default function HardwareSettingsClient() {
  const [data, setData] = useState<{
      locations: Location[];
      devices: Device[];
      routes: Array<{
        id: string;
        target_type: string;
        target_id: string;
        printer_name: string;
      }>;
      jobs: Job[];
      paymentStations: PaymentStation[];
      printSettings: { externalKitchenAutoPrint: boolean };
    } | null>(null),
    [message, setMessage] = useState(""),
    [locationName, setLocationName] = useState(""),
    [editingId, setEditingId] = useState(""),
    [editingKey, setEditingKey] = useState(""),
    [deviceName, setDeviceName] = useState(""),
    [deviceType, setDeviceType] = useState("printer"),
    [role, setRole] = useState("receipt_printer"),
    [adapter, setAdapter] = useState("unconfigured"),
    [printerHost, setPrinterHost] = useState(""),
    [printerPort, setPrinterPort] = useState(9100),
    [ticketTextSize, setTicketTextSize] = useState("normal"),
    [ticketHeaderSize, setTicketHeaderSize] = useState("large"),
    [tillKey, setTillKey] = useState(""),
    [cashDrawerEnabled, setCashDrawerEnabled] = useState(false),
    [receiptEnabled, setReceiptEnabled] = useState(false),
    [stationName,setStationName]=useState(""),
    [stationKey,setStationKey]=useState(""),
    [stationMode,setStationMode]=useState<"payment"|"order_taker">("order_taker"),
    [stationReceiptPrinterId,setStationReceiptPrinterId]=useState(""),
    [stationPaymentTerminalId,setStationPaymentTerminalId]=useState(""),
    [stationGiftReaderId,setStationGiftReaderId]=useState(""),
    [stationPhonePayments,setStationPhonePayments]=useState(true),
    [stationCustomerDisplay,setStationCustomerDisplay]=useState(false),
    [stationRegisterKey,setStationRegisterKey]=useState(""),
    [assignedStationKey,setAssignedStationKey]=useState(""),
    [locationId, setLocationId] = useState(""),
    [routePrinterId, setRoutePrinterId] = useState(""),
    [targetType, setTargetType] = useState("all"),
    [targetId, setTargetId] = useState(""),
    [paymentProvider, setPaymentProvider] = useState<{ provider:string;label:string;configured:boolean;onlineCheckoutEnabled:boolean;terminalCheckoutEnabled:boolean;sandbox:boolean;missing:string[] } | null>(null),
    [paymentProviderBusy, setPaymentProviderBusy] = useState(false);
  async function load() {
    const [response, paymentResponse] = await Promise.all([
      fetch("/api/ordering/settings/hardware", { cache: "no-store" }),
      fetch("/api/ordering/payments/status", { cache: "no-store" }),
    ]),
      [body, paymentBody] = await Promise.all([response.json(), paymentResponse.json()]);
    if (!response.ok)
      throw new Error(body.error || "Could not load hardware configuration.");
    setData(body);
    if (!locationId && body.locations[0]) setLocationId(body.locations[0].id);
    if (paymentResponse.ok) setPaymentProvider(paymentBody);
  }
  useEffect(() => {
    setAssignedStationKey(localStorage.getItem("corner-ops-station-key")||"");
    void load().catch((error) => setMessage(error.message));
  }, []);
  async function action(body: Record<string, unknown>) {
    const response = await fetch("/api/ordering/settings/hardware", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Hardware update failed.");
    await load();
  }
  async function guarded(body: Record<string, unknown>, success: string) {
    setMessage("");
    try {
      await action(body);
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Hardware update failed.",
      );
      return false;
    }
  }
  function setKind(value: string) {
    setDeviceType(value);
    setRole(
      value === "printer"
        ? "receipt_printer"
        : value === "payment_terminal"
          ? "payment_terminal"
          : "barcode_scanner",
    );
    setAdapter(
      value === "payment_terminal" ? "payment-placeholder" : "unconfigured",
    );
  }
  function editDevice(device: Device) {
    setEditingId(device.id);
    setEditingKey(device.device_key);
    setLocationId(device.location_id);
    setDeviceName(device.name);
    setDeviceType(device.device_type);
    setRole(device.role);
    setAdapter(device.adapter_key);
    setPrinterHost(device.adapter_config?.host || "");
    setPrinterPort(Number(device.adapter_config?.port || 9100));
    setTicketTextSize(device.adapter_config?.ticketTextSize || "normal");
    setTicketHeaderSize(device.adapter_config?.ticketHeaderSize || "large");
    setTillKey(device.adapter_config?.tillKey || "");
    setCashDrawerEnabled(Boolean(device.adapter_config?.cashDrawerEnabled));
    setReceiptEnabled(device.role === "receipt_printer" || Boolean(device.adapter_config?.receiptEnabled));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearDevice() {
    setEditingId("");
    setEditingKey("");
    setDeviceName("");
    setPrinterHost("");
    setPrinterPort(9100);
    setTicketTextSize("normal");
    setTicketHeaderSize("large");
    setTillKey("");
    setCashDrawerEnabled(false);
    setReceiptEnabled(false);
  }
  return (
    <section className="posSettingsCard">
      <h2>Hardware & print queue</h2>
      <p>
        Manager/owner configuration only. Status comes from an adapter
        heartbeat: stale devices are offline, and unconfigured devices remain
        unknown. No live credentials are stored here.
      </p>
      {message && <p role="status">{message}</p>}
      <h3>Payment provider</h3>
      <div className="autoPrintControl">
        <div>
          <strong>{paymentProvider?.configured ? `${paymentProvider.label.toUpperCase()} CONFIGURED` : `${paymentProvider?.label?.toUpperCase()||"PAYMENT PROVIDER"} SETUP REQUIRED`}</strong>
          <p>
            Online checkout: {paymentProvider?.onlineCheckoutEnabled?"ready":"not ready"} · Terminal checkout: {paymentProvider?.terminalCheckoutEnabled?"ready":"not ready"}{paymentProvider?.sandbox?" · SANDBOX":""}
          </p>
          <small>Credentials are read from the server environment and are never shown or stored in this page.</small>
        </div>
        <button type="button" disabled={!paymentProvider?.configured || paymentProviderBusy} onClick={() => {
          setPaymentProviderBusy(true); setMessage("");
          void fetch("/api/ordering/payments/status", { method: "POST" })
            .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "Payment provider connection failed."); setMessage(`${paymentProvider?.label||"Payment provider"} connection verified.`); })
            .catch((error) => setMessage(error instanceof Error ? error.message : "Payment provider connection failed."))
            .finally(() => setPaymentProviderBusy(false));
        }}>TEST PROVIDER</button>
      </div>
      <h3>Automatic kitchen tickets</h3>
      <div className="autoPrintControl">
        <div>
          <strong>AUTOMATIC KITCHEN PRINTING</strong>
          <p>
            {data?.printSettings.externalKitchenAutoPrint
              ? "Enabled — submitted POS, kiosk, online, and AI orders print immediately."
              : "Paused — all orders still reach the POS and kitchen screen without automatically using paper. Explicit test prints and manager reprints remain available."}
          </p>
        </div>
        <button
          type="button"
          className={data?.printSettings.externalKitchenAutoPrint ? "rocker on" : "rocker"}
          role="switch"
          aria-checked={Boolean(data?.printSettings.externalKitchenAutoPrint)}
          disabled={!data}
          onClick={() =>
            void guarded(
              { action: "save_print_settings", externalKitchenAutoPrint: !data?.printSettings.externalKitchenAutoPrint },
              data?.printSettings.externalKitchenAutoPrint ? "Automatic kitchen printing paused." : "Automatic kitchen printing enabled.",
            )
          }
        >
          <span aria-hidden="true" />
          {data?.printSettings.externalKitchenAutoPrint ? "ON" : "PAUSED"}
        </button>
      </div>
      <h3>Locations</h3>
      <div className="posTools">
        <input
          aria-label="Location name"
          placeholder="Location name"
          value={locationName}
          onChange={(e) => setLocationName(e.target.value)}
        />
        <button
          disabled={!locationName}
          onClick={() =>
            void guarded(
              {
                action: "save_location",
                name: locationName,
                locationKey: locationName.toLowerCase().replace(/\W+/g, "-"),
              },
              "Location saved.",
            ).then(() => setLocationName(""))
          }
        >
          ADD LOCATION
        </button>
      </div>
      <h3>Devices</h3>
      <div className="posSettingsGrid">
        <label>
          LOCATION
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {data?.locations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          NAME
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
          />
        </label>
        <label>
          TYPE
          <select value={deviceType} onChange={(e) => setKind(e.target.value)}>
            <option value="printer">Printer</option>
            <option value="payment_terminal">Payment terminal</option>
            <option value="barcode_scanner">Barcode scanner</option>
          </select>
        </label>
        {deviceType === "printer" && (
          <label>
            ROLE
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="receipt_printer">Receipt</option>
              <option value="kitchen_printer">Kitchen</option>
            </select>
          </label>
        )}
        <label>
          CONNECTION
          <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            <option value="unconfigured">Not configured</option>
            {deviceType === "printer" && (
              <option value="network-printer">Network printer (TCP/IP)</option>
            )}
            {deviceType === "payment_terminal" && (
              <option value="payment-placeholder">Payment placeholder</option>
            )}
            {deviceType === "barcode_scanner" && (
              <option value="keyboard-wedge">USB/Bluetooth keyboard-wedge reader</option>
            )}
            <option value="mock">Test/mock</option>
          </select>
        </label>
        {deviceType === "printer" && adapter === "network-printer" && (
          <>
            <label>
              PRINTER IP / HOST
              <input
                inputMode="url"
                autoComplete="off"
                placeholder="192.168.1.50"
                value={printerHost}
                onChange={(e) => setPrinterHost(e.target.value)}
              />
            </label>
            <label>
              PORT
              <input
                type="number"
                min="1"
                max="65535"
                value={printerPort}
                onChange={(e) => setPrinterPort(Number(e.target.value))}
              />
            </label>
            <label>
              TICKET BODY TEXT
              <select
                value={ticketTextSize}
                onChange={(e) => setTicketTextSize(e.target.value)}
              >
                <option value="normal">Normal</option>
                <option value="large">Large (2×)</option>
                <option value="extra_large">Extra large (3×)</option>
              </select>
            </label>
            <label>
              TICKET HEADER TEXT
              <select
                value={ticketHeaderSize}
                onChange={(e) => setTicketHeaderSize(e.target.value)}
              >
                <option value="normal">Normal</option>
                <option value="large">Large (2×)</option>
                <option value="extra_large">Extra large (3×)</option>
              </select>
            </label>
            {role === "receipt_printer" && (
              <>
                <label>
                  TILL / REGISTER
                  <input
                    value={tillKey}
                    onChange={(e) => setTillKey(e.target.value)}
                    placeholder="Front Till"
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={cashDrawerEnabled}
                    onChange={(e) => setCashDrawerEnabled(e.target.checked)}
                  />
                  Cash drawer connected to this receipt printer
                </label>
              </>
            )}
            {role === "kitchen_printer" && <><label><input type="checkbox" checked={receiptEnabled} onChange={(e) => setReceiptEnabled(e.target.checked)} />Also use this kitchen printer for receipts</label>{receiptEnabled && <><label>TILL / REGISTER<input value={tillKey} onChange={(e) => setTillKey(e.target.value)} placeholder="Shared Back Register" /></label><label><input type="checkbox" checked={cashDrawerEnabled} onChange={(e) => setCashDrawerEnabled(e.target.checked)} />Cash drawer connected to this printer</label></>}</>}
          </>
        )}
        <button
          disabled={
            !locationId ||
            !deviceName ||
            (adapter === "network-printer" && !printerHost.trim())
          }
          onClick={() =>
            void guarded(
              {
                action: "save_device",
                id: editingId || undefined,
                locationId,
                name: deviceName,
                deviceKey:
                  editingKey || deviceName.toLowerCase().replace(/\W+/g, "-"),
                deviceType,
                role,
                adapterKey: adapter,
                adapterConfig:
                  adapter === "network-printer"
                    ? {
                        host: printerHost.trim(),
                        port: printerPort,
                        ticketTextSize,
                        ticketHeaderSize,
                        tillKey,
                        cashDrawerEnabled,
                        receiptEnabled,
                      }
                    : {},
              },
              editingId
                ? "Printer updated."
                : "Device saved. Use Test Print to verify it.",
            ).then(clearDevice)
          }
        >
          {editingId ? "SAVE CHANGES" : "ADD DEVICE"}
        </button>
        {editingId && (
          <button type="button" onClick={clearDevice}>
            CANCEL EDIT
          </button>
        )}
      </div>
      <div>
        {data?.devices.map((device) => (
          <article key={device.id}>
            <strong>{device.name}</strong> · {device.role.replaceAll("_", " ")}{" "}
            · <b>{device.effective_status.toUpperCase()}</b> ·{" "}
            {device.adapter_key}
            {device.adapter_key === "network-printer" && (
              <span>
                {" "}
                · {device.adapter_config?.host}:
                {device.adapter_config?.port || 9100}
              </span>
            )}
            <span> {device.status_message}</span>
            <div className="posTools">
              {device.active && (
                <>
                  <button onClick={() => editDevice(device)}>EDIT</button>
                  <button
                    onClick={() =>
                      void guarded(
                        { action: "probe_device", id: device.id },
                        "Printer connection checked.",
                      )
                    }
                  >
                    {device.adapter_key === "network-printer"
                      ? "CHECK CONNECTION"
                      : "CHECK STATUS"}
                  </button>
                  {device.adapter_key === "network-printer" && (
                    <><button
                      onClick={() =>
                        void guarded(
                          { action: "test_print", id: device.id },
                          "Epson test print sent.",
                        )
                      }
                    >
                      TEST PRINT
                    </button>{device.adapter_config?.receiptEnabled&&device.adapter_config?.cashDrawerEnabled&&<button onClick={()=>void guarded({action:"test_cash_drawer",id:device.id},"Cash-drawer test sent.")}>TEST DRAWER</button>}</>
                  )}
                  <button
                    onClick={() => {
                      if (
                        confirm(`Remove ${device.name} from active printers?`)
                      )
                        void guarded(
                          { action: "deactivate_device", id: device.id },
                          "Printer removed.",
                        );
                    }}
                  >
                    REMOVE
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      <h3>POS registers & customer displays</h3>
      <p>Create one station for each register. Its clearly labeled station key pairs that register with its customer display.</p>
      <div className="posSettingsGrid">
        <label>STATION NAME<input value={stationName} onChange={event=>{setStationName(event.target.value);if(!stationKey)setStationKey(event.target.value.toLowerCase().replace(/\W+/g,"-"))}} /></label>
        <label>STATION KEY<input value={stationKey} onChange={event=>setStationKey(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g,""))} /></label>
        <label>MODE<select value={stationMode} onChange={event=>setStationMode(event.target.value as "payment"|"order_taker")}><option value="order_taker">Order taking only</option><option value="payment">Designated payment station</option></select></label>
        <label>REGISTER PRINTER / CASH DRAWER<select value={stationReceiptPrinterId} onChange={event=>{const id=event.target.value;setStationReceiptPrinterId(id);const printer=data?.devices.find(device=>device.id===id);if(printer?.adapter_config?.tillKey)setStationRegisterKey(printer.adapter_config.tillKey.toLowerCase().replace(/[^a-z0-9-]/g,"-"))}}><option value="">No register attached</option>{data?.devices.filter(device=>device.role==="receipt_printer"||(device.role==="kitchen_printer"&&device.adapter_config?.receiptEnabled)).map(device=><option key={device.id} value={device.id}>{device.name}{device.role==="kitchen_printer"?" (kitchen + receipts)":""}{device.adapter_config?.cashDrawerEnabled?" + drawer":""}</option>)}</select></label>
        <label>REGISTER KEY<input value={stationRegisterKey} onChange={event=>setStationRegisterKey(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g,""))} placeholder={stationMode==="payment"?"front-register":"back-register"} /><small>Stations selecting the same printer/drawer should use the same register key.</small></label>
        <label><input type="checkbox" checked={stationPhonePayments} onChange={event=>setStationPhonePayments(event.target.checked)} />Allow card payments taken by phone on this POS</label>
        <label><input type="checkbox" checked={stationCustomerDisplay} onChange={event=>setStationCustomerDisplay(event.target.checked)} />This POS has a customer display (CDS)</label>
        {stationMode==="payment"&&<>
          <label>DHARMA TERMINAL<select value={stationPaymentTerminalId} onChange={event=>setStationPaymentTerminalId(event.target.value)}><option value="">Pending Dharma hardware</option>{data?.devices.filter(device=>device.role==="payment_terminal").map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
          <label>GIFT-CARD SWIPER<select value={stationGiftReaderId} onChange={event=>setStationGiftReaderId(event.target.value)}><option value="">Choose reader</option>{data?.devices.filter(device=>device.role==="barcode_scanner").map(device=><option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
        </>}
        <button disabled={!stationName||!stationKey||(stationMode==="payment"&&!stationReceiptPrinterId)} onClick={()=>void guarded({action:"save_payment_station",name:stationName,stationKey,stationMode,receiptPrinterId:stationReceiptPrinterId||null,paymentTerminalId:stationPaymentTerminalId||null,giftCardReaderId:stationGiftReaderId||null,phoneCardPaymentsEnabled:stationPhonePayments,customerDisplayEnabled:stationCustomerDisplay,sharedRegisterKey:stationRegisterKey},"POS station saved.").then(saved=>{if(saved){setStationName("");setStationKey("")}})}>ADD STATION</button>
      </div>
      <div className="posStationCards">{data?.paymentStations.map(station=><article key={station.id} className={assignedStationKey===station.station_key?"activeStation":""}><div><strong>{station.name}</strong><span>{station.station_mode==="payment"?"FRONT PAYMENT REGISTER":"BACK ORDER-TAKING POS"}{assignedStationKey===station.station_key?" · THIS POS":""}</span></div><label>STATION KEY<code>{station.station_key}</code></label><small>{station.shared_register_key?`Register: ${station.shared_register_key}`:"No shared register key"}{station.phone_card_payments_enabled?" · Phone card payments enabled":""}{station.customer_display_enabled?" · CDS enabled":""}{station.receipt_printer_name?` · Printer: ${station.receipt_printer_name}`:""}{station.payment_terminal_name?` · Terminal: ${station.payment_terminal_name}`:""}</small><div className="posTools"><button onClick={()=>{setStationName(station.name);setStationKey(station.station_key);setStationMode(station.station_mode);setStationReceiptPrinterId(station.receipt_printer_id||"");setStationPaymentTerminalId(station.payment_terminal_id||"");setStationGiftReaderId(station.gift_card_reader_id||"");setStationPhonePayments(station.phone_card_payments_enabled);setStationCustomerDisplay(station.customer_display_enabled);setStationRegisterKey(station.shared_register_key||"");window.scrollTo({top:0,behavior:"smooth"})}}>CONFIGURE</button><button onClick={()=>void navigator.clipboard.writeText(station.station_key).then(()=>setMessage(`Copied station key: ${station.station_key}`))}>COPY KEY</button><button onClick={()=>{localStorage.setItem("corner-ops-station-key",station.station_key);setAssignedStationKey(station.station_key);setMessage(`${station.name} is now assigned to this POS. Reload the POS to apply it.`)}}>USE ON THIS POS</button>{station.customer_display_enabled&&<a className="button" target="_blank" href={`/display/deli?station=${encodeURIComponent(station.station_key)}`}>OPEN CUSTOMER DISPLAY</a>}</div></article>)}{data&&data.paymentStations.length===0&&<div className="noticeBar">No POS registers exist yet. Enter a station name and key above, choose its mode and hardware, then select ADD STATION.</div>}</div>
      <h3>Printer routing</h3>
      <p>
        Kitchen printers can be routed by all items, stable item/category ID, or
        station key. Higher priority wins.
      </p>
      <div className="posSettingsGrid">
        <label>
          KITCHEN PRINTER
          <select
            value={routePrinterId}
            onChange={(e) => setRoutePrinterId(e.target.value)}
          >
            <option value="">Choose printer</option>
            {data?.devices
              .filter(
                (row) =>
                  row.active &&
                  row.role === "kitchen_printer" &&
                  row.location_id === locationId,
              )
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          TARGET TYPE
          <select
            value={targetType}
            onChange={(e) => {
              setTargetType(e.target.value);
              if (e.target.value === "all") setTargetId("");
            }}
          >
            <option value="all">All items</option>
            <option value="item">Stable item ID</option>
            <option value="category">Stable category ID</option>
            <option value="station">Station key</option>
          </select>
        </label>
        {targetType !== "all" && (
          <label>
            TARGET
            <input
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder={targetType === "station" ? "grill" : "Stable UUID"}
            />
          </label>
        )}
        <button
          disabled={!routePrinterId || (targetType !== "all" && !targetId)}
          onClick={() =>
            void guarded(
              {
                action: "save_route",
                locationId,
                printerId: routePrinterId,
                targetType,
                targetId,
                priority: 0,
              },
              "Printer route saved.",
            )
          }
        >
          ADD ROUTE
        </button>
      </div>
      <div>
        {data?.routes.map((route) => (
          <article key={route.id}>
            {route.target_type}: {route.target_id || "all"} →{" "}
            <strong>{route.printer_name}</strong>
          </article>
        ))}
      </div>
      <h3>Recent print jobs</h3>
      <div>
        {data?.jobs.map((job) => (
          <article key={job.id}>
            <strong>{job.purpose.replaceAll("_", " ")}</strong> ·{" "}
            {job.status.toUpperCase()} · retries {job.retry_count}
            {job.is_reprint ? " · REPRINT" : ""} ·{" "}
            {job.device_name || "unrouted"}{" "}
            {job.error_message && `· ${job.error_message}`}
            <div className="posTools">
              {["failed", "not_configured"].includes(job.status) && (
                <button
                  onClick={() => {
                    const reason = window.prompt("Reason for retry?");
                    if (reason)
                      void guarded(
                        { action: "retry", jobId: job.id, reason },
                        "Print job queued for retry.",
                      );
                  }}
                >
                  RETRY
                </button>
              )}
              <button
                onClick={() => {
                  const reason = window.prompt("Reason for reprint?");
                  if (reason)
                    void guarded(
                      { action: "reprint", jobId: job.id, reason },
                      "Authorized reprint queued.",
                    );
                }}
              >
                REPRINT
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
