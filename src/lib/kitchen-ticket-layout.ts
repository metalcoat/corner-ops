import type { ServiceType } from "@/lib/ordering-core";
import { kitchenServiceName } from "@/lib/ordering-kitchen-ticket";

/** Characters across an 80 mm kitchen printer at normal text size (576 dots, 12 dots a character). */
export const TICKET_COLUMNS = 48;
/** The split-pizza column header formatKitchenLines prints; the printer draws circles in its place. */
export const PIZZA_PORTION_HEADER = "LEFT        |WHOLE       |RIGHT";

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

/**
 * A kitchen ticket: PICKUP / DELIVERY / … large at the top (the first line prints in the header size),
 * then the order number, phone and payment on the left and the customer's name, address and due time on
 * the right, then the items. "ADD ON" tickets keep that word in front of the service.
 */
export function kitchenTicketLayout(payload: Record<string, unknown>): string[] {
  const service = kitchenServiceName(String(payload.serviceType || "") as ServiceType);
  const addOn = String(payload.heading || "") === "ADD ON";
  const timing = (Array.isArray(payload.timingLines) ? payload.timingLines : []).map(String);
  const dueLine = timing.find((line) => /^(DUE|FOR): /.test(line));
  const due = dueLine ? `${dueLine.startsWith("FOR") ? "FOR" : "DUE"} ${dueLine.replace(/^(DUE|FOR): /, "").replaceAll(",", "")}` : "";
  // A plain "*** ASAP PICKUP ***" banner repeats the header, so it goes; FUTURE / PREORDER banners and the quote stay.
  const otherTiming = timing.filter((line) => line !== dueLine && (!/^\*\*\*.*\*\*\*$/.test(line.trim()) || /FUTURE|PREORDER/.test(line)));

  const half = TICKET_COLUMNS / 2;
  const left = [
    payload.orderNumber ? `#${payload.orderNumber}` : "",
    payload.phone ? String(payload.phone) : "",
    payload.paymentLabel ? String(payload.paymentLabel) : "",
    payload.cashier ? `CASHIER: ${payload.cashier}` : "",
  ].filter(Boolean).flatMap((line) => wrap(line, half - 1));
  const right = [
    ...wrap(String(payload.customerName || ""), half - 1),
    ...wrap(String(payload.deliveryAddress || ""), half - 1),
    ...(payload.deliveryUnit ? wrap(`DROP-OFF: ${payload.deliveryUnit}`, half - 1) : []),
    ...(due ? wrap(due, half - 1) : []),
  ];
  const lines = [addOn ? `ADD ON - ${service}` : service];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "", r = right[i] ?? "";
    lines.push(`${l}${" ".repeat(Math.max(1, TICKET_COLUMNS - l.length - r.length))}${r}`);
  }
  lines.push(...otherTiming);
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
