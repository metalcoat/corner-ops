import { printPayloadLines } from "../src/lib/ordering-hardware";
import { kitchenTicketTimingLines } from "../src/lib/ordering-kitchen-ticket";

const pickupTiming = kitchenTicketTimingLines({
  timingMode: "asap",
  serviceType: "pickup",
  promisedFor: new Date("2026-08-21T18:30:00Z"),
  quotedLeadMinMinutes: 30,
  quotedLeadMaxMinutes: 30,
  snapshotLabel: "*** ASAP PICKUP ***\nQUOTE: 30 MIN",
});
const deliveryTiming = kitchenTicketTimingLines({
  timingMode: "asap",
  serviceType: "delivery",
  promisedFor: new Date("2026-08-21T19:00:00Z"),
  quotedLeadMinMinutes: 60,
  quotedLeadMaxMinutes: 60,
  snapshotLabel: "*** ASAP DELIVERY ***\nQUOTE: 60 MIN",
});
const futureTiming = kitchenTicketTimingLines({
  timingMode: "future",
  serviceType: "delivery",
  scheduledFor: new Date("2026-08-22T22:15:00Z"),
});
const delivery = printPayloadLines({
  heading: "KITCHEN ORDER",
  orderNumber: "1284",
  customerName: "Sarah Smith",
  phone: "315-555-1212",
  serviceType: "delivery",
  deliveryAddress: "1121 Paterson Street, Ogdensburg, NY 13669",
  deliveryUnit: "Lane 14",
  orderInstructions: "Please ring the side-door bell",
  timingLines: deliveryTiming,
  paymentLabel: "AMOUNT DUE: $24.75",
  lines: ["1 X PIZZA"],
});
const paid = printPayloadLines({
  heading: "KITCHEN ORDER",
  orderNumber: "1285",
  customerName: "Paid Guest",
  phone: "315-555-1213",
  serviceType: "pickup",
  timingLines: pickupTiming,
  paymentLabel: "PAID",
  lines: ["1 X SUB"],
});

// The service prints large on the first line; order number, phone and payment sit on the left,
// the customer, address and due time on the right of the same rows.
if (delivery[0] !== "DELIVERY - DUE $24.75" || paid[0] !== "PICKUP - PAID") throw new Error(`Ticket header is wrong: ${delivery[0]} / ${paid[0]}`);
const deliveryText = delivery.join("\n");
for (const expected of [
  "#1284",
  "Sarah Smith",
  "(315) 555-1212",
  "1121 Paterson Street,",
  "Ogdensburg, NY 13669",
  "DROP-OFF: Lane 14",
  "INSTRUCTIONS: Please ring the side-door bell",
  "ASAP 3:00 PM",
]) {
  if (!deliveryText.includes(expected))
    throw new Error(`Delivery ticket is missing: ${expected}`);
}
const future = printPayloadLines({ heading: "KITCHEN ORDER", orderNumber: "1286", customerName: "Later Guest", serviceType: "delivery", timingLines: futureTiming, paymentLabel: "PAID", lines: ["1 X SUB"] });
if (!future.join("\n").includes("EXACT Aug 22 6:15 PM") || future.some((line) => /FUTURE|QUOTE/.test(line)))
  throw new Error(`Future ticket timing is wrong: ${future.join(" / ")}`);
if (delivery.some((line) => line.length > 48)) throw new Error("A ticket line is wider than the paper.");
const nameRow = delivery.find((line) => line.includes("Sarah Smith")) || "";
if (!nameRow.startsWith("#1284") || !nameRow.endsWith("Sarah Smith")) throw new Error(`Name is not top right: ${nameRow}`);
if (paid.some((line) => line.includes("QUOTE")) || paid.some((line) => line.includes("AMOUNT DUE")))
  throw new Error("Paid ticket status is incorrect.");
if (
  !pickupTiming.includes("QUOTE: 30 MIN") ||
  !futureTiming.some((line) => line.startsWith("DUE: Sat, Aug 22, 6:15 PM"))
)
  throw new Error("Pickup or future timing is incorrect.");

console.log(
  JSON.stringify(
    {
      customer: true,
      phone: true,
      deliveryAddress: true,
      dropoff: true,
      serviceType: true,
      pickupDue: true,
      deliveryDue: true,
      futureDue: true,
      amountDue: true,
      paid: true,
    },
    null,
    2,
  ),
);
