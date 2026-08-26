export type DeliveryRouteStopInput = {
  deliveryId: string;
  displayNumber: string;
  customerName: string;
  address: string;
  latitude: number;
  longitude: number;
  timingMode: string;
  scheduledFor: string | null;
  createdAt: string;
};

export type DeliveryRouteStop = DeliveryRouteStopInput & {
  sequence: number;
  estimatedArrival: string;
  dueAt: string;
  timingRisk: "on_track" | "due_soon" | "late";
  legMiles: number;
};

export type DeliveryRoutePlan = {
  stops: DeliveryRouteStop[];
  navigationUrl: string | null;
  totalStraightLineMiles: number;
  urgentStops: number;
  calculatedAt: string;
};

type Coordinate = { latitude: number; longitude: number };

export function deliveryOrigin(env: NodeJS.ProcessEnv = process.env): Coordinate | null {
  const latitude = Number(env.DELI_ORIGIN_LATITUDE);
  const longitude = Number(env.DELI_ORIGIN_LONGITUDE);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

export function straightLineMiles(from: Coordinate, to: Coordinate) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function dueAt(stop: DeliveryRouteStopInput) {
  if (stop.timingMode === "future" && stop.scheduledFor)
    return new Date(stop.scheduledFor);
  return new Date(new Date(stop.createdAt).getTime() + 45 * 60_000);
}

function travelMinutes(miles: number) {
  return Math.max(3, Math.ceil(miles * 3));
}

export function googleMultiStopUrl(stops: DeliveryRouteStop[]) {
  if (!stops.length) return null;
  const navigable = stops.slice(0, 10);
  const destination = navigable.at(-1)!;
  const parameters = new URLSearchParams({
    api: "1",
    travelmode: "driving",
    destination: `${destination.latitude},${destination.longitude}`,
  });
  if (navigable.length > 1)
    parameters.set(
      "waypoints",
      navigable
        .slice(0, -1)
        .map((stop) => `${stop.latitude},${stop.longitude}`)
        .join("|"),
    );
  return `https://www.google.com/maps/dir/?${parameters}`;
}

export function planDeliveryRoute(
  input: DeliveryRouteStopInput[],
  origin: Coordinate,
  now = new Date(),
): DeliveryRoutePlan {
  const remaining = input.filter(
    (stop) =>
      Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude),
  );
  const stops: DeliveryRouteStop[] = [];
  let cursor = origin;
  let clock = new Date(now);
  let totalStraightLineMiles = 0;

  while (remaining.length) {
    const ranked = remaining.map((stop) => {
      const miles = straightLineMiles(cursor, stop);
      const arrival = new Date(clock.getTime() + travelMinutes(miles) * 60_000);
      const due = dueAt(stop);
      return {
        stop,
        miles,
        arrival,
        due,
        slackMinutes: (due.getTime() - arrival.getTime()) / 60_000,
      };
    });
    const urgent = ranked.filter((candidate) => candidate.slackMinutes <= 15);
    const next = (urgent.length ? urgent : ranked).toSorted((left, right) =>
      urgent.length
        ? left.due.getTime() - right.due.getTime() || left.miles - right.miles
        : left.miles - right.miles || left.due.getTime() - right.due.getTime(),
    )[0];
    const timingRisk =
      next.slackMinutes < 0
        ? "late"
        : next.slackMinutes <= 15
          ? "due_soon"
          : "on_track";
    stops.push({
      ...next.stop,
      sequence: stops.length + 1,
      estimatedArrival: next.arrival.toISOString(),
      dueAt: next.due.toISOString(),
      timingRisk,
      legMiles: Math.round(next.miles * 10) / 10,
    });
    totalStraightLineMiles += next.miles;
    cursor = next.stop;
    clock = new Date(next.arrival.getTime() + 4 * 60_000);
    remaining.splice(remaining.indexOf(next.stop), 1);
  }

  return {
    stops,
    navigationUrl: googleMultiStopUrl(stops),
    totalStraightLineMiles: Math.round(totalStraightLineMiles * 10) / 10,
    urgentStops: stops.filter((stop) => stop.timingRisk !== "on_track").length,
    calculatedAt: now.toISOString(),
  };
}
