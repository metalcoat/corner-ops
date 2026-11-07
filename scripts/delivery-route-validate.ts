import { planDeliveryRoute } from "../src/lib/ordering-delivery-route";

const now = new Date("2026-08-26T16:00:00.000Z");
const base = {
  customerName: "Customer",
  timingMode: "future",
  createdAt: "2026-08-26T15:30:00.000Z",
};
const plan = planDeliveryRoute(
  [
    {
      ...base,
      deliveryId: "near",
      displayNumber: "101",
      address: "Near stop",
      latitude: 42.0005,
      longitude: -78,
      scheduledFor: "2026-08-26T17:00:00.000Z",
    },
    {
      ...base,
      deliveryId: "urgent",
      displayNumber: "102",
      address: "Urgent stop",
      latitude: 42.03,
      longitude: -78,
      scheduledFor: "2026-08-26T16:08:00.000Z",
    },
    {
      ...base,
      deliveryId: "near-next",
      displayNumber: "103",
      address: "Nearby second stop",
      latitude: 42.031,
      longitude: -78,
      scheduledFor: "2026-08-26T17:15:00.000Z",
    },
  ],
  { latitude: 42, longitude: -78 },
  now,
);

if (plan.stops[0]?.deliveryId !== "urgent")
  throw new Error("A time-critical stop must override the nearest-stop preference.");
if (plan.stops[1]?.deliveryId !== "near-next")
  throw new Error("After the urgent stop, routing should choose the nearby stop to prevent backtracking.");
if (!plan.navigationUrl?.includes("waypoints="))
  throw new Error("A multi-stop Google Maps route was not generated.");
if (plan.stops.some((stop, index) => stop.sequence !== index + 1))
  throw new Error("Route sequence is not stable.");

console.log(
  JSON.stringify(
    {
      deadlineAwareFirstStop: plan.stops[0].deliveryId,
      nearbySecondStop: plan.stops[1].deliveryId,
      multiStopNavigation: true,
      timingRisk: plan.stops[0].timingRisk,
    },
    null,
    2,
  ),
);
