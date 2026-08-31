import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { ensureOrderingHardwareSchema } from "@/lib/ordering-hardware-schema";

export type DeviceStatus = "online" | "offline" | "unknown";
export interface HardwareAdapter {
  readonly key: string;
  readonly kind: "printer" | "payment_terminal" | "barcode_scanner";
  probe(
    config: Record<string, unknown>,
  ): Promise<{ status: DeviceStatus; message: string }>;
}
export class UnconfiguredAdapter implements HardwareAdapter {
  readonly key: string = "unconfigured";
  constructor(readonly kind: HardwareAdapter["kind"]) {}
  async probe() {
    return {
      status: "unknown" as const,
      message: "No hardware adapter is configured.",
    };
  }
}
export class MockDeviceAdapter implements HardwareAdapter {
  readonly key: string = "mock";
  constructor(readonly kind: HardwareAdapter["kind"]) {}
  async probe(config: Record<string, unknown>) {
    const requested = config.mockStatus;
    const status: DeviceStatus =
      requested === "online" || requested === "offline" ? requested : "unknown";
    return {
      status,
      message:
        status === "unknown"
          ? "Mock status was not explicitly configured."
          : `Mock adapter explicitly reports ${status}.`,
    };
  }
}
export class NetworkPrinterAdapter implements HardwareAdapter {
  readonly key = "network-printer";
  readonly kind = "printer" as const;
  async probe(config: Record<string, unknown>) {
    const host = String(config.host || "").trim(),
      port = Number(config.port || 9100);
    if (
      !validPrinterHost(host) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535
    )
      return {
        status: "unknown" as const,
        message: "A valid printer IP/host and port are required.",
      };
    return new Promise<{ status: DeviceStatus; message: string }>((resolve) => {
      const socket = new Socket(),
        finish = (status: DeviceStatus, message: string) => {
          socket.destroy();
          resolve({ status, message });
        };
      socket.setTimeout(2500);
      socket.once("connect", () =>
        finish("online", `TCP connection succeeded to ${host}:${port}.`),
      );
      socket.once("timeout", () =>
        finish("offline", `Connection to ${host}:${port} timed out.`),
      );
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          "offline",
          `Could not connect to ${host}:${port} (${error.code || "connection error"}).`,
        ),
      );
      socket.connect(port, host);
    });
  }
}
function epsonTextSize(value: unknown) {
  return value === "extra_large" ? 0x22 : value === "large" ? 0x11 : 0x00;
}
export async function sendEpsonPrint(
  config: Record<string, unknown>,
  lines: string[],
  options: { openCashDrawer?: boolean } = {},
) {
  const host = String(config.host || "").trim(),
    port = Number(config.port || 9100);
  if (
    !validPrinterHost(host) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("A valid printer IP/host and port are required.");
  const safeLines = lines.map((line) =>
      String(line)
        .replace(/[^\x20-\x7E]/g, "?")
        .slice(0, 500),
    ),
    headerSize = epsonTextSize(config.ticketHeaderSize),
    bodySize = epsonTextSize(config.ticketTextSize),
    drawer =
      options.openCashDrawer && config.cashDrawerEnabled === true
        ? Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])
        : Buffer.alloc(0);
  const data = Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    drawer,
    Buffer.from([0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01, 0x1d, 0x21, headerSize]),
    Buffer.from(`${safeLines[0] || "CORNER OPS"}\n`, "ascii"),
    Buffer.from([0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00, 0x1d, 0x21, bodySize]),
    Buffer.from(`${safeLines.slice(1).join("\n")}\n\n\n`, "ascii"),
    Buffer.from([0x1d, 0x21, 0x00, 0x1d, 0x56, 0x42, 0x00]),
  ]);
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket(),
      fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
    socket.setTimeout(4000);
    socket.once("timeout", () =>
      fail(new Error(`Print to ${host}:${port} timed out.`)),
    );
    socket.once("error", fail);
    socket.connect(port, host, () => socket.end(data));
    socket.once("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
}
export class PaymentTerminalPlaceholderAdapter extends UnconfiguredAdapter {
  readonly key = "payment-placeholder";
  constructor() {
    super("payment_terminal");
  }
}
export class KeyboardWedgeAdapter extends UnconfiguredAdapter {
  readonly key = "keyboard-wedge";
  constructor() { super("barcode_scanner"); }
  async probe(){return {status:"unknown" as const,message:"Keyboard-wedge reader is configured locally; swipe a test gift card at checkout to verify it."}}
}
export function hardwareAdapter(
  key: string,
  kind: HardwareAdapter["kind"],
): HardwareAdapter {
  if (key === "network-printer" && kind === "printer")
    return new NetworkPrinterAdapter();
  if (key === "mock") return new MockDeviceAdapter(kind);
  if (key === "payment-placeholder" && kind === "payment_terminal")
    return new PaymentTerminalPlaceholderAdapter();
  if (key === "keyboard-wedge" && kind === "barcode_scanner") return new KeyboardWedgeAdapter();
  return new UnconfiguredAdapter(kind);
}

function manager(actor: OrderingActor) {
  if (!canManagePos(actor))
    throw new Error("Manager or owner authorization is required.");
}
function validPrinterHost(value: string) {
  if (
    !value ||
    value.length > 253 ||
    !/^[a-z0-9.-]+$/i.test(value) ||
    value.startsWith(".") ||
    value.endsWith(".")
  )
    return false;
  const parts = value.split(".").map(Number);
  if (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  )
    return (
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 127
    );
  return (
    !value.includes(".") ||
    value.toLowerCase().endsWith(".local") ||
    value.toLowerCase().endsWith(".lan")
  );
}
function safeConfig(value: unknown): Record<string, unknown> {
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (
    Object.keys(config).some((key) =>
      /secret|password|token|credential|api.?key/i.test(key),
    )
  )
    throw new Error(
      "Credentials and secrets cannot be stored in device configuration.",
    );
  return config;
}
export function effectiveDeviceStatus(row: {
  active: boolean;
  reported_status: DeviceStatus;
  last_seen_at?: string | Date | null;
}): DeviceStatus {
  if (!row.active) return "offline";
  if (!row.last_seen_at) return "unknown";
  if (Date.now() - new Date(row.last_seen_at).getTime() > 120_000)
    return "offline";
  return row.reported_status;
}

export async function hardwareDashboard(business: OrderingBusiness) {
  await ensureOrderingHardwareSchema();
  const sql = getSql();
  const [locations, devices, routes, jobs, paymentStations] = await Promise.all([
    sql`SELECT * FROM ordering_hardware_locations WHERE business=${business} AND active=TRUE ORDER BY name`,
    sql`SELECT device.*,location.name location_name FROM ordering_hardware_devices device JOIN ordering_hardware_locations location ON location.id=device.location_id WHERE device.business=${business} AND device.active=TRUE AND location.active=TRUE ORDER BY location.name,device.name`,
    sql`SELECT route.*,device.name printer_name,location.name location_name FROM ordering_printer_routes route JOIN ordering_hardware_devices device ON device.id=route.printer_id JOIN ordering_hardware_locations location ON location.id=route.location_id WHERE route.business=${business} AND route.active=TRUE AND device.active=TRUE AND location.active=TRUE ORDER BY route.priority DESC,route.created_at`,
    sql`SELECT job.id,job.order_id,job.purpose,job.event_subtype,job.status,job.is_reprint,job.retry_count,job.error_message,job.queued_at,job.attempted_at,job.completed_at,job.device_id,device.name device_name FROM ordering_print_jobs job LEFT JOIN ordering_hardware_devices device ON device.id=job.device_id WHERE job.business=${business} ORDER BY job.created_at DESC LIMIT 100`,
    sql`SELECT station.*,receipt.name receipt_printer_name,terminal.name payment_terminal_name,reader.name gift_card_reader_name FROM ordering_payment_stations station LEFT JOIN ordering_hardware_devices receipt ON receipt.id=station.receipt_printer_id LEFT JOIN ordering_hardware_devices terminal ON terminal.id=station.payment_terminal_id LEFT JOIN ordering_hardware_devices reader ON reader.id=station.gift_card_reader_id WHERE station.business=${business} AND station.active=TRUE ORDER BY station.station_mode,station.name`,
  ]);
  return {
    locations,
    devices: devices.map((row: any) => ({
      ...row,
      effective_status: effectiveDeviceStatus(row),
    })),
    routes,
    jobs,
    paymentStations,
  };
}

export async function operationalPrinterStatus(business: OrderingBusiness) {
  await ensureOrderingHardwareSchema();
  const sql = getSql();
  const devices =
    await sql`SELECT id,name,role,adapter_key,adapter_config FROM ordering_hardware_devices WHERE business=${business} AND device_type='printer' AND active=TRUE AND role IN ('kitchen_printer','receipt_printer')`;
  const checked = await Promise.all(
    devices.map(async (device: any) => {
      const result = await hardwareAdapter(
        String(device.adapter_key),
        "printer",
      ).probe(device.adapter_config || {});
      await sql`UPDATE ordering_hardware_devices SET reported_status=${result.status},last_seen_at=NOW(),status_message=${result.message},updated_at=NOW() WHERE id=${device.id}`;
      return { role: String(device.role), status: result.status };
    }),
  );
  function roleStatus(role: string) {
    const matches = checked.filter((device) => device.role === role);
    if (!matches.length) return "not_configured" as const;
    if (matches.some((device) => device.status === "online"))
      return "online" as const;
    if (matches.some((device) => device.status === "unknown"))
      return "unknown" as const;
    return "offline" as const;
  }
  return {
    kitchenPrinter: roleStatus("kitchen_printer"),
    receiptPrinter: roleStatus("receipt_printer"),
    receiptPrinters: devices
      .filter((device: any) => device.role === "receipt_printer")
      .map((device: any) => ({
        id: String(device.id),
        name: String(device.name),
        tillKey: String(device.adapter_config?.tillKey || ""),
        cashDrawerEnabled: device.adapter_config?.cashDrawerEnabled === true,
      })),
    checkedAt: new Date().toISOString(),
  };
}

export async function saveHardware(input: {
  business: OrderingBusiness;
  action: string;
  body: Record<string, unknown>;
  actor: OrderingActor;
}): Promise<any> {
  manager(input.actor);
  await ensureOrderingHardwareSchema();
  const sql = getSql(),
    body = input.body;
  if (input.action === "save_location") {
    const id = String(body.id || randomUUID()),
      name = String(body.name || "").trim(),
      key = String(body.locationKey || "")
        .trim()
        .toLowerCase();
    if (!name || !key) throw new Error("Location name and key are required.");
    await sql`INSERT INTO ordering_hardware_locations(id,business,name,location_key,active) VALUES(${id},${input.business},${name},${key},${body.active !== false}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,location_key=EXCLUDED.location_key,active=EXCLUDED.active,updated_at=NOW() WHERE ordering_hardware_locations.business=${input.business}`;
    return { id };
  }
  if (input.action === "save_device") {
    const id = String(body.id || randomUUID()),
      name = String(body.name || "").trim(),
      deviceKey = String(body.deviceKey || "")
        .trim()
        .toLowerCase(),
      locationId = String(body.locationId || ""),
      deviceType = String(body.deviceType || ""),
      role = String(body.role || ""),
      adapterKey = String(body.adapterKey || "unconfigured");
    if (!name || !deviceKey || !locationId)
      throw new Error("Device name, key, and location are required.");
    if (
      !["printer", "payment_terminal", "barcode_scanner"].includes(deviceType)
    )
      throw new Error("Unknown device type.");
    const expected = {
      printer: ["receipt_printer", "kitchen_printer"],
      payment_terminal: ["payment_terminal"],
      barcode_scanner: ["barcode_scanner"],
    }[deviceType]!;
    if (!expected.includes(role))
      throw new Error("Device role does not match its type.");
    if (
      ![
        "unconfigured",
        "mock",
        "payment-placeholder",
        "network-printer",
        "keyboard-wedge",
      ].includes(adapterKey) ||
      (adapterKey === "payment-placeholder" &&
        deviceType !== "payment_terminal") ||
      (adapterKey === "network-printer" && deviceType !== "printer")
      || (adapterKey === "keyboard-wedge" && deviceType !== "barcode_scanner")
    )
      throw new Error("Unsupported adapter.");
    const config = safeConfig(body.adapterConfig);
    if (adapterKey === "network-printer") {
      const host = String(config.host || "").trim(),
        port = Number(config.port || 9100),
        sizes = ["normal", "large", "extra_large"];
      if (!validPrinterHost(host))
        throw new Error("Enter a valid printer IP address or hostname.");
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new Error("Printer port must be between 1 and 65535.");
      config.host = host;
      config.port = port;
      config.ticketTextSize = sizes.includes(String(config.ticketTextSize))
        ? String(config.ticketTextSize)
        : "normal";
      config.ticketHeaderSize = sizes.includes(String(config.ticketHeaderSize))
        ? String(config.ticketHeaderSize)
        : "large";
      config.tillKey = role === "receipt_printer"
        ? String(config.tillKey || "").trim().slice(0, 80)
        : "";
      config.cashDrawerEnabled = role === "receipt_printer" && config.cashDrawerEnabled === true;
    }
    const rows =
      await sql`INSERT INTO ordering_hardware_devices(id,business,location_id,name,device_key,device_type,role,station_key,adapter_key,adapter_config,active,created_by,updated_by) SELECT ${id},${input.business},id,${name},${deviceKey},${deviceType},${role},${String(body.stationKey || "").trim()},${adapterKey},${JSON.stringify(config)}::jsonb,${body.active !== false},${input.actor.id},${input.actor.id} FROM ordering_hardware_locations WHERE id=${locationId} AND business=${input.business} ON CONFLICT(id) DO UPDATE SET location_id=EXCLUDED.location_id,name=EXCLUDED.name,device_key=EXCLUDED.device_key,device_type=EXCLUDED.device_type,role=EXCLUDED.role,station_key=EXCLUDED.station_key,adapter_key=EXCLUDED.adapter_key,adapter_config=EXCLUDED.adapter_config,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=NOW() WHERE ordering_hardware_devices.business=${input.business} RETURNING id`;
    if (!rows.length)
      throw new Error("Hardware location was not found in this business.");
    return { id };
  }
  if (input.action === "save_payment_station") {
    const id = String(body.id || randomUUID()),
      name = String(body.name || "").trim(),
      stationKey = String(body.stationKey || "").trim().toLowerCase(),
      stationMode = String(body.stationMode || "order_taker"),
      receiptPrinterId = body.receiptPrinterId ? String(body.receiptPrinterId) : null,
      paymentTerminalId = body.paymentTerminalId ? String(body.paymentTerminalId) : null,
      giftCardReaderId = body.giftCardReaderId ? String(body.giftCardReaderId) : null;
    if (!name || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(stationKey)) throw new Error("Station name and a stable lowercase station key are required.");
    if (!['payment','order_taker'].includes(stationMode)) throw new Error("Unknown station mode.");
    if (stationMode === 'payment' && !receiptPrinterId) throw new Error("The payment station requires a receipt printer / till.");
    const deviceIds = [receiptPrinterId,paymentTerminalId,giftCardReaderId].filter(Boolean) as string[];
    if (deviceIds.length) {
      const matched = await sql`SELECT id,role FROM ordering_hardware_devices WHERE business=${input.business} AND active=TRUE AND id=ANY(${deviceIds}::uuid[])`;
      if (matched.length !== new Set(deviceIds).size) throw new Error("One or more station devices were not found.");
      const roleById = new Map(matched.map((row:any)=>[String(row.id),String(row.role)]));
      if (receiptPrinterId && roleById.get(receiptPrinterId) !== 'receipt_printer') throw new Error("Choose a receipt printer for the till.");
      if (paymentTerminalId && roleById.get(paymentTerminalId) !== 'payment_terminal') throw new Error("Choose a payment terminal.");
      if (giftCardReaderId && roleById.get(giftCardReaderId) !== 'barcode_scanner') throw new Error("Choose a scanner / magnetic-stripe reader.");
    }
    const saved=(await sql`INSERT INTO ordering_payment_stations(id,business,name,station_key,station_mode,receipt_printer_id,payment_terminal_id,gift_card_reader_id,active,created_by,updated_by) VALUES(${id},${input.business},${name},${stationKey},${stationMode},${receiptPrinterId},${paymentTerminalId},${giftCardReaderId},TRUE,${input.actor.id},${input.actor.id}) ON CONFLICT(business,station_key) DO UPDATE SET name=EXCLUDED.name,station_mode=EXCLUDED.station_mode,receipt_printer_id=EXCLUDED.receipt_printer_id,payment_terminal_id=EXCLUDED.payment_terminal_id,gift_card_reader_id=EXCLUDED.gift_card_reader_id,active=TRUE,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING id`)[0];
    return {id:String(saved.id)};
  }
  if (input.action === "probe_device") {
    const id = String(body.id || "");
    const device = (
      await sql`SELECT * FROM ordering_hardware_devices WHERE id=${id} AND business=${input.business}`
    )[0];
    if (!device) throw new Error("Device not found.");
    const result = await hardwareAdapter(
      device.adapter_key,
      device.device_type,
    ).probe(device.adapter_config);
    await sql`UPDATE ordering_hardware_devices SET reported_status=${result.status},last_seen_at=NOW(),status_message=${result.message},updated_by=${input.actor.id},updated_at=NOW() WHERE id=${id}`;
    return result;
  }
  if (input.action === "test_print") {
    const id = String(body.id || "");
    const device = (
      await sql`SELECT * FROM ordering_hardware_devices WHERE id=${id} AND business=${input.business} AND device_type='printer' AND active=TRUE`
    )[0];
    if (!device) throw new Error("Active printer not found.");
    if (device.adapter_key !== "network-printer")
      throw new Error(
        "Configure this printer as Network printer (TCP/IP) first.",
      );
    await sendEpsonPrint(device.adapter_config, [
      "******** TEST - DO NOT MAKE ********",
      "CORNER OPS PRINTER TEST",
      device.name,
      `${device.role.replaceAll("_", " ")} - ${new Date().toISOString()}`,
      "If you can read this, ESC/POS printing works.",
    ]);
    await sql`UPDATE ordering_hardware_devices SET reported_status='online',last_seen_at=NOW(),status_message='Epson ESC/POS test print sent successfully.',updated_by=${input.actor.id},updated_at=NOW() WHERE id=${id}`;
    return { status: "online", message: "Epson ESC/POS test print sent." };
  }
  if (input.action === "test_cash_drawer") {
    const id=String(body.id||"");
    const device=(await sql`SELECT * FROM ordering_hardware_devices WHERE id=${id} AND business=${input.business} AND role='receipt_printer' AND active=TRUE`)[0];
    if(!device)throw new Error("Active receipt printer was not found.");
    if(device.adapter_key!=="network-printer"||device.adapter_config?.cashDrawerEnabled!==true)throw new Error("Enable the cash drawer on a network receipt printer first.");
    await sendEpsonPrint(device.adapter_config,["******** DRAWER TEST ********",`OPENED BY: ${input.actor.name}`,new Date().toISOString()],{openCashDrawer:true});
    await sql`INSERT INTO ordering_pos_audit_events(id,business,event_type,actor,reason,details) VALUES(${randomUUID()},${input.business},'cash_drawer_test',${input.actor.id},'Manager hardware test',${JSON.stringify({printerId:id,printerName:device.name})}::jsonb)`;
    return {status:"online",message:"Cash-drawer pulse and marked test receipt sent."};
  }
  if (input.action === "deactivate_device") {
    const id = String(body.id || "");
    const rows =
      await sql`UPDATE ordering_hardware_devices SET active=FALSE,reported_status='offline',status_message='Removed from active hardware.',updated_by=${input.actor.id},updated_at=NOW() WHERE id=${id} AND business=${input.business} RETURNING id`;
    if (!rows.length) throw new Error("Printer not found.");
    await sql`UPDATE ordering_printer_routes SET active=FALSE,updated_by=${input.actor.id},updated_at=NOW() WHERE printer_id=${id} AND business=${input.business}`;
    return { id, active: false };
  }
  if (input.action === "save_route") {
    const id = String(body.id || randomUUID()),
      locationId = String(body.locationId || ""),
      printerId = String(body.printerId || ""),
      targetType = String(body.targetType || "all"),
      targetId = String(body.targetId || "").trim();
    if (
      !["all", "item", "category", "station"].includes(targetType) ||
      (targetType !== "all") !== Boolean(targetId)
    )
      throw new Error("A valid route target is required.");
    const printer = (
      await sql`SELECT id FROM ordering_hardware_devices WHERE id=${printerId} AND business=${input.business} AND location_id=${locationId} AND device_type='printer' AND role='kitchen_printer'`
    )[0];
    if (!printer)
      throw new Error(
        "Kitchen printer was not found in this business/location.",
      );
    await sql`INSERT INTO ordering_printer_routes(id,business,location_id,printer_id,target_type,target_id,priority,active,created_by,updated_by) VALUES(${id},${input.business},${locationId},${printerId},${targetType},${targetId},${Number(body.priority || 0)},${body.active !== false},${input.actor.id},${input.actor.id}) ON CONFLICT(id) DO UPDATE SET location_id=EXCLUDED.location_id,printer_id=EXCLUDED.printer_id,target_type=EXCLUDED.target_type,target_id=EXCLUDED.target_id,priority=EXCLUDED.priority,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=NOW() WHERE ordering_printer_routes.business=${input.business}`;
    return { id };
  }
  throw new Error("Unknown hardware configuration action.");
}

export async function controlPrintJob(input: {
  business: OrderingBusiness;
  jobId: string;
  action: "retry" | "reprint";
  reason: string;
  actor: OrderingActor;
}) {
  manager(input.actor);
  await ensureOrderingHardwareSchema();
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required.");
  return withTransaction(async () => {
    const sql = getSql();
    const job = (
      await sql`SELECT * FROM ordering_print_jobs WHERE id=${input.jobId} AND business=${input.business} FOR UPDATE`
    )[0];
    if (!job) throw new Error("Print job not found.");
    if (input.action === "retry") {
      if (!["failed", "not_configured"].includes(job.status))
        throw new Error("Only failed or unconfigured jobs can be retried.");
      await sql`UPDATE ordering_print_jobs SET status='queued',queued_at=NOW(),next_attempt_at=NOW(),retry_count=retry_count+1,error_message='',actor_type=${input.actor.type},actor_id=${input.actor.id} WHERE id=${job.id}`;
      return { id: job.id, orderId: job.order_id, status: "queued" };
    }
    const id = randomUUID(),
      key = `reprint:${job.id}:${id}`;
    await sql`INSERT INTO ordering_print_jobs(id,business,order_id,check_id,payment_transaction_id,purpose,event_subtype,status,is_reprint,actor_type,actor_id,error_message,payload,location_id,device_id,idempotency_key,parent_job_id) VALUES(${id},${input.business},${job.order_id},${job.check_id},${job.payment_transaction_id},${job.purpose},'authorized_reprint','queued',TRUE,${input.actor.type},${input.actor.id},'',${JSON.stringify({ ...job.payload, reprintReason: reason })}::jsonb,${job.location_id},${job.device_id},${key},${job.id})`;
    return { id, orderId: job.order_id, status: "queued" };
  });
}

export function printPayloadLines(payload: Record<string, unknown>) {
  const lines = [String(payload.heading || "CORNER OPS")];
  if (payload.orderNumber) lines.push(`ORDER: #${payload.orderNumber}`);
  if (payload.customerName) lines.push(`CUSTOMER: ${payload.customerName}`);
  if (payload.phone) lines.push(`PHONE: ${payload.phone}`);
  if (payload.serviceType)
    lines.push(
      `TYPE: ${String(payload.serviceType).replaceAll("_", " ").toUpperCase()}`,
    );
  if (payload.deliveryAddress)
    lines.push(`DELIVER TO: ${payload.deliveryAddress}`);
  if (payload.deliveryUnit) lines.push(`DROP-OFF: ${payload.deliveryUnit}`);
  if (Array.isArray(payload.timingLines))
    for (const line of payload.timingLines) lines.push(String(line));
  if (payload.paymentLabel) lines.push(String(payload.paymentLabel));
  if (payload.cashier) lines.push(`CASHIER: ${payload.cashier}`);
  if (Array.isArray(payload.lines)) {
    lines.push("--------------------------------");
    for (const line of payload.lines)
      lines.push(typeof line === "string" ? line : JSON.stringify(line));
  }
  for (const key of [
    "paidThisUpdateCents",
    "totalPaidCents",
    "remainingDueCents",
    "changeDueCents",
  ]) {
    if (payload[key] !== undefined)
      lines.push(
        `${key.replace(/([A-Z])/g, " $1").toUpperCase()}: $${(Number(payload[key]) / 100).toFixed(2)}`,
      );
  }
  return lines;
}
export async function dispatchOrderPrintJobs(
  orderId: string,
  business: OrderingBusiness,
  options: { includeKitchenProduction?: boolean; jobId?: string } = {},
) {
  await ensureOrderingHardwareSchema();
  const sql = getSql(),
    includeKitchen = options.includeKitchenProduction !== false,
    jobId = options.jobId || null,
    jobs =
      await sql`SELECT * FROM ordering_print_jobs WHERE order_id=${orderId} AND business=${business} AND status IN('not_configured','queued') AND (${includeKitchen} OR purpose<>'kitchen_production') AND (${jobId}::uuid IS NULL OR id=${jobId}::uuid) ORDER BY created_at,id`;
  for (const job of jobs) {
    if (job.payload?.customerReceiptPending === true) continue;
    const role =
      job.purpose === "kitchen_production"
        ? "kitchen_printer"
        : "receipt_printer";
    const targetPrinterId = role === "receipt_printer" && job.payload?.receiptPrinterId
      ? String(job.payload.receiptPrinterId)
      : null;
    const device = (
      await sql`SELECT device.* FROM ordering_hardware_devices device LEFT JOIN ordering_printer_routes route ON route.printer_id=device.id AND route.active=TRUE WHERE device.business=${business} AND device.role=${role} AND device.active=TRUE AND device.adapter_key='network-printer' AND (${targetPrinterId}::uuid IS NULL OR device.id=${targetPrinterId}::uuid) ORDER BY COALESCE(route.priority,0) DESC,device.created_at LIMIT 1`
    )[0];
    if (!device) {
      await sql`UPDATE ordering_print_jobs SET status='not_configured',error_message=${role === "kitchen_printer" ? "Kitchen printer not configured." : "Receipt printer not configured."} WHERE id=${job.id}`;
      continue;
    }
    await sql`UPDATE ordering_print_jobs SET status='attempting',device_id=${device.id},location_id=${device.location_id},attempted_at=NOW(),error_message='' WHERE id=${job.id}`;
    try {
      await sendEpsonPrint(
        device.adapter_config,
        printPayloadLines(job.payload || {}),
        { openCashDrawer: job.payload?.openCashDrawer === true },
      );
      await sql`UPDATE ordering_print_jobs SET status='succeeded',completed_at=NOW(),error_message='' WHERE id=${job.id}`;
      await sql`UPDATE ordering_hardware_devices SET reported_status='online',last_seen_at=NOW(),status_message='Last ESC/POS print completed.',updated_at=NOW() WHERE id=${device.id}`;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Printer connection failed.";
      await sql`UPDATE ordering_print_jobs SET status='failed',error_message=${message},retry_count=retry_count+1,next_attempt_at=NOW()+INTERVAL '30 seconds' WHERE id=${job.id}`;
      await sql`UPDATE ordering_hardware_devices SET reported_status='offline',last_seen_at=NOW(),status_message=${message},updated_at=NOW() WHERE id=${device.id}`;
    }
  }
}
