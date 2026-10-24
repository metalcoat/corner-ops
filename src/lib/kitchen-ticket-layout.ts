import type { ServiceType } from "@/lib/ordering-core";
import { kitchenServiceName } from "@/lib/ordering-kitchen-ticket";

/** Characters across an 80 mm kitchen printer at normal text size (576 dots, 12 dots a character). */
export const TICKET_COLUMNS = 48;
/** The split-pizza column header formatKitchenLines prints; the printer draws circles in its place. */
export const PIZZA_PORTION_HEADER = "LEFT        |WHOLE       |RIGHT";
/** A ticket line printed large and inverted (white on black); still readable as plain text. */
export const DUE_BANNER = /^\*\*\* (.+) \*\*\*$/;
export function dueBanner(text: string): string { return `*** ${text} ***`; }

function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!row) row = word.slice(0, width);
    else if (`${row} ${word}`.length <= width) row += ` ${word}`;
    else { rows.push(row); row = word.slice(0, width); }
  }
  if (row) rows.push(row);
  return rows;
}

/** (315) 555-1212 from +13155551212 or 315-555-1212; anything else as given. */
export function ticketPhone(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

/** The address as a driver reads it: no country, no ZIP+4 ("412 Jay Street, Ogdensburg, NY 13669"). */
export function ticketAddress(value: string): string {
  return value.replace(/,\s*(USA|United States)\s*$/i, "").replace(/\b(\d{5})-\d{4}\b/, "$1").trim();
}

/**
 * A kitchen ticket: the service and whether it's paid large at the top ("PICKUP - PAID",
 * "DELIVERY - DUE $33.50"; the first line prints in the header size), then the order number and phone on
 * the left and the customer's name, address and time on the right ("ASAP 8:52 PM", or "PREORDER 9/23
 * 11:00 AM" for a preorder or future order), then the items. No quote line: the time says it.
 * "ADD ON" tickets keep that word in front of the service and their payment line on the left.
 */
export function kitchenTicketLayout(payload: Record<string, unknown>): string[] {
  const service = kitchenServiceName(String(payload.serviceType || "") as ServiceType);
  const addOn = String(payload.heading || "") === "ADD ON";
  const timing = (Array.isArray(payload.timingLines) ? payload.timingLines : []).map(String);
  const dueLine = timing.find((line) => /^(DUE|FOR): /.test(line));
  const exact = timing.some((line) => /FUTURE|PREORDER/.test(line)) || Boolean(dueLine?.startsWith("FOR"));
  // "DUE: Wed, Sep 23, 11:00 AM" → ASAP shows the time; a preorder also shows the date ("PREORDER 9/23 11:00 AM").
  const when = (dueLine || "").replace(/^(DUE|FOR): /, "").split(", ");
  const time = when.at(-1) || "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = (when.at(-2) || "").replace(/^([A-Z][a-z]{2}) (\d+)$/, (_, m: string, d: string) => `${months.indexOf(m) + 1}/${d}`);
  const due = exact ? `PREORDER ${time ? `${day} ${time}` : "TIME REQUIRED"}` : `ASAP${time ? ` ${time}` : ""}`;
  const paymentLabel = String(payload.paymentLabel || "");
  const amountDue = paymentLabel.match(/^AMOUNT DUE: (\$[\d,.]+)$/);
  const payment = paymentLabel === "PAID" ? "PAID" : amountDue ? `DUE ${amountDue[1]}` : "";

  const half = TICKET_COLUMNS / 2;
  const left = [
    payload.orderNumber ? `#${payload.orderNumber}` : "",
    payload.phone ? ticketPhone(String(payload.phone)) : "",
    addOn || !payment ? paymentLabel : "",
    payload.cashier ? `CASHIER: ${payload.cashier}` : "",
  ].filter(Boolean).flatMap((line) => wrap(line, half - 1));
  const right = [
    ...wrap(String(payload.customerName || ""), half - 1),
    ...wrap(ticketAddress(String(payload.deliveryAddress || "")), half - 1),
    ...(payload.deliveryUnit ? wrap(`DROP-OFF: ${payload.deliveryUnit}`, half - 1) : []),
    ...wrap(due, half - 1),
  ];
  const lines = [addOn ? `ADD ON - ${service}` : payment ? `${service} - ${payment}` : service];
  // Scheduled orders: a large white-on-black due banner under the header (see DUE_BANNER).
  if (exact && time) lines.push(dueBanner(`DUE ${day ? `${day} ` : ""}${time}`));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "", r = right[i] ?? "";
    lines.push(`${l}${" ".repeat(Math.max(1, TICKET_COLUMNS - l.length - r.length))}${r}`);
  }
  if (payload.orderInstructions) lines.push(...wrap(`INSTRUCTIONS: ${payload.orderInstructions}`, TICKET_COLUMNS));
  if (Array.isArray(payload.lines)) {
    lines.push("-".repeat(TICKET_COLUMNS));
    for (const line of payload.lines) lines.push(typeof line === "string" ? line : JSON.stringify(line));
  }
  return lines;
}

/**
 * The split-pizza header as a picture: a left-half circle, a full circle and a right-half circle over the
 * three topping columns (ESC/POS raster, GS v 0). `charDots` = dots per character at the body text size.
 */
export function pizzaPortionRaster(charDots = 12): Uint8Array {
  const width = 576, height = 34, bytes = width / 8, radius = 14, ring = 2.2;
  const centers = [6, 19, 32].map((c) => c * charDots); // middles of the 12-character columns
  const data = new Uint8Array(8 + bytes * height);
  data.set([0x1d, 0x76, 0x30, 0x00, bytes & 0xff, bytes >> 8, height & 0xff, height >> 8]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      centers.forEach((cx, i) => {
        const dx = x - cx, dy = y - height / 2, d = Math.hypot(dx, dy);
        if (d > radius) return;
        const filled = i === 1 || (i === 0 ? dx <= 0 : dx >= 0);
        if (d >= radius - ring || filled) on = true;
      });
      if (on) data[8 + y * bytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return data;
}
