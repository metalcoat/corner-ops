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
    [locationId, setLocationId] = useState(""),
    [routePrinterId, setRoutePrinterId] = useState(""),
    [targetType, setTargetType] = useState("all"),
    [targetId, setTargetId] = useState("");
  async function load() {
    const response = await fetch("/api/ordering/settings/hardware", {
        cache: "no-store",
      }),
      body = await response.json();
    if (!response.ok)
      throw new Error(body.error || "Could not load hardware configuration.");
    setData(body);
    if (!locationId && body.locations[0]) setLocationId(body.locations[0].id);
  }
  useEffect(() => {
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
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Hardware update failed.",
      );
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
                    <button
                      onClick={() =>
                        void guarded(
                          { action: "test_print", id: device.id },
                          "Epson test print sent.",
                        )
                      }
                    >
                      TEST PRINT
                    </button>
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
