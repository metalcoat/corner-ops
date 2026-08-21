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
  timingLines: deliveryTiming,
  paymentLabel: "AMOUNT DUE: $24.75",
  lines: ["1 X PIZZA"],
});
const paid = printPayloadLines({ heading: "KITCHEN ORDER", orderNumber: "1285", customerName: "Paid Guest", phone: "315-555-1213", serviceType: "pickup", timingLines: pickupTiming, paymentLabel: "PAID", lines: ["1 X SUB"] });

for (const expected of ["ORDER: #1284", "CUSTOMER: Sarah Smith", "PHONE: 315-555-1212", "TYPE: DELIVERY", "DELIVER TO: 1121 Paterson Street, Ogdensburg, NY 13669", "DROP-OFF: Lane 14", "QUOTE: 60 MIN", "DUE: Aug 21, 3:00 PM", "AMOUNT DUE: $24.75"]) {
  if (!delivery.includes(expected)) throw new Error(`Delivery ticket is missing: ${expected}`);
}
if (!paid.includes("PAID") || paid.some((line) => line.includes("AMOUNT DUE"))) throw new Error("Paid ticket status is incorrect.");
if (!pickupTiming.includes("QUOTE: 30 MIN") || !futureTiming.some((line) => line.startsWith("DUE: Aug 22, 6:15 PM"))) throw new Error("Pickup or future timing is incorrect.");

console.log(JSON.stringify({ customer: true, phone: true, deliveryAddress: true, dropoff: true, serviceType: true, pickupDue: true, deliveryDue: true, futureDue: true, amountDue: true, paid: true }, null, 2));
