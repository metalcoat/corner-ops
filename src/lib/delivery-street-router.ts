/**
 * Street-by-street delivery routing for Ogdensburg (owner request 2026-10-29): drive the quiet through
 * streets the owner marked preferred (Jay, Greene, Lafayette), stay off streets with a stop sign every
 * block (marked avoid), follow one-way streets, and count each stop sign and traffic light as lost time.
 * Built from src/lib/route-map/ogdensburg.json (tools/route-map/build-route-map.py); pure, no database.
 */
import type { DeliveryRoutePlan, DeliveryRouteStop, DeliveryRouteStopInput } from "@/lib/ordering-delivery-route";

export type RouteMapData = {
  names: string[];
  classes: string[];
  nodes: Array<[number, number]>;
  /** [name index, class index, oneway (1 forward, -1 backward, 0 both), node indexes] */
  ways: Array<[number, number, number, number[]]>;
  signals: number[];
  /** [junction, approach node] — traffic arriving from that neighbour stops; -1 = all-way stop. */
  stops: Array<[number, number]>;
  prefs: Record<string, "prefer" | "avoid">;
};
type Coordinate = { latitude: number; longitude: number };

/** Typical in-town speeds, metres per second. */
const SPEED: Record<string, number> = { trunk: 13.9, primary: 12.5, secondary: 11.1, tertiary: 10, residential: 8.3, unclassified: 8.3, living_street: 4, service: 5 };
export const STOP_SIGN_SECONDS = 12;
export const SIGNAL_SECONDS = 20;
/** How much the planner favours a preferred street / penalises an avoided one (cost, not the time shown). */
export const PREFER_FACTOR = 0.65;
export const AVOID_FACTOR = 2.5;
/** How much of an avoid street a trip may drive to reach (or leave) an address on it. */
export const AVOID_NEAR_METRES = 250;
const DROP_OFF_MINUTES = 4;

type Edge = { to: number; metres: number; seconds: number; cost: number; name: number; stop: boolean; pref: "prefer" | "avoid" | null };
export type DriveManeuver = "depart" | "straight" | "slight_left" | "slight_right" | "left" | "right" | "sharp_left" | "sharp_right" | "uturn" | "arrive";
/** One spoken/shown direction: where it happens, what to do, and how far the next stretch runs. */
export type DriveStep = { latitude: number; longitude: number; maneuver: DriveManeuver; instruction: string; street: string; metres: number };
export type StreetLeg = { seconds: number; metres: number; stopSigns: number; preferredMetres: number; avoidMetres: number; path: Array<[number, number]>; streets: string[]; steps: DriveStep[] };

function bearing(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180, y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad);
  const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const shortName = (name: string) => name || "the road";

/** Turn-by-turn directions along a path of street edges: a step wherever the street name changes. */
function driveSteps(points: Array<[number, number]>, names: string[]): DriveStep[] {
  if (points.length < 2) return [];
  const steps: DriveStep[] = [];
  let street = names[0], start = 0;
  const stretch = (from: number, to: number) => { let total = 0; for (let i = from; i < to; i++) total += metres(points[i], points[i + 1]); return total; };
  steps.push({ latitude: points[0][0], longitude: points[0][1], maneuver: "depart", street, metres: 0,
    instruction: `Head ${COMPASS[Math.round(bearing(points[0], points[1]) / 45) % 8]} on ${shortName(street)}` });
  for (let i = 1; i < names.length; i++) {
    if (!names[i] || names[i] === street) continue;
    steps.at(-1)!.metres = stretch(start, i);
    let delta = bearing(points[i], points[i + 1]) - bearing(points[i - 1], points[i]);
    delta = ((delta + 540) % 360) - 180;
    const size = Math.abs(delta), side = delta > 0 ? "right" : "left";
    const maneuver: DriveManeuver = size < 25 ? "straight" : size < 55 ? (`slight_${side}` as DriveManeuver) : size < 125 ? side : size < 165 ? (`sharp_${side}` as DriveManeuver) : "uturn";
    const verb = maneuver === "straight" ? "Continue onto" : maneuver === "uturn" ? "Make a U-turn onto" : maneuver.startsWith("slight") ? `Bear ${side} onto` : maneuver.startsWith("sharp") ? `Turn sharp ${side} onto` : `Turn ${side} onto`;
    street = names[i]; start = i;
    steps.push({ latitude: points[i][0], longitude: points[i][1], maneuver, street, metres: 0, instruction: `${verb} ${shortName(street)}` });
  }
  steps.at(-1)!.metres = stretch(start, points.length - 1);
  const last = points.at(-1)!;
  steps.push({ latitude: last[0], longitude: last[1], maneuver: "arrive", street, metres: 0, instruction: "You have arrived" });
  return steps;
}

function metres(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

class Heap {
  private items: Array<[number, number]> = [];
  get size() { return this.items.length; }
  push(cost: number, node: number) {
    const items = this.items; items.push([cost, node]);
    for (let i = items.length - 1; i > 0;) { const parent = (i - 1) >> 1; if (items[parent][0] <= items[i][0]) break; [items[parent], items[i]] = [items[i], items[parent]]; i = parent; }
  }
  pop(): [number, number] {
    const items = this.items, top = items[0], last = items.pop()!;
    if (items.length) {
      items[0] = last;
      for (let i = 0; ;) {
        const left = 2 * i + 1, right = left + 1; let smallest = i;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === i) break; [items[smallest], items[i]] = [items[i], items[smallest]]; i = smallest;
      }
    }
    return top;
  }
}

export class StreetRouter {
  readonly data: RouteMapData;
  private adjacency: Edge[][];
  private routable: number[];
  /** Street names (indexes) at each node, for "an avoid street is fine only if you're starting or ending on it". */
  private nodeNames = new Map<number, Set<number>>();

  constructor(data: RouteMapData) {
    this.data = data;
    const stopAt = new Map<number, Set<number>>();
    for (const [junction, from] of data.stops) { const set = stopAt.get(junction) ?? new Set(); set.add(from); stopAt.set(junction, set); }
    const signals = new Set(data.signals);
    this.adjacency = data.nodes.map(() => []);
    for (const [nameIndex, classIndex, oneway, path] of data.ways) {
      const speed = SPEED[data.classes[classIndex]] ?? 8.3;
      const pref = data.prefs[data.names[nameIndex]] ?? null;
      const factor = pref === "prefer" ? PREFER_FACTOR : pref === "avoid" ? AVOID_FACTOR : 1;
      const add = (from: number, to: number) => {
        const length = metres(data.nodes[from], data.nodes[to]);
        const stopSet = stopAt.get(to), stop = Boolean(stopSet && (stopSet.has(-1) || stopSet.has(from)));
        const wait = (stop ? STOP_SIGN_SECONDS : 0) + (signals.has(to) ? SIGNAL_SECONDS : 0);
        const seconds = length / speed + wait;
        this.adjacency[from].push({ to, metres: length, seconds, cost: (length / speed) * factor + wait * 1.5, name: nameIndex, stop, pref });
      };
      for (let i = 1; i < path.length; i++) {
        if (oneway !== -1) add(path[i - 1], path[i]);
        if (oneway !== 1) add(path[i], path[i - 1]);
      }
    }
    for (const [nameIndex, , , path] of data.ways) for (const node of path) { const set = this.nodeNames.get(node) ?? new Set(); set.add(nameIndex); this.nodeNames.set(node, set); }
    // Snap only to nodes on named public streets in the biggest part of the network where every node can be
    // driven to and back from every other (one-way pieces at the map's edge can be dead ends).
    const named = new Set<number>();
    for (const [nameIndex, , , path] of data.ways) if (data.names[nameIndex]) for (const node of path) named.add(node);
    const core = this.largestStronglyConnected();
    this.routable = [...named].filter((node) => core.has(node));
  }

  /** Kosaraju: the largest set of nodes all reachable from one another, following one-way rules. */
  private largestStronglyConnected(): Set<number> {
    const count = this.data.nodes.length, reverse: number[][] = Array.from({ length: count }, () => []);
    this.adjacency.forEach((edges, from) => { for (const edge of edges) reverse[edge.to].push(from); });
    const seen = new Uint8Array(count), order: number[] = [];
    for (let root = 0; root < count; root++) {
      if (seen[root]) continue;
      const stack: Array<[number, number]> = [[root, 0]]; seen[root] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1], edges = this.adjacency[top[0]];
        if (top[1] < edges.length) { const next = edges[top[1]++].to; if (!seen[next]) { seen[next] = 1; stack.push([next, 0]); } }
        else { order.push(top[0]); stack.pop(); }
      }
    }
    const component = new Int32Array(count).fill(-1), sizes: number[] = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const root = order[i]; if (component[root] >= 0) continue;
      const id = sizes.length, queue = [root]; component[root] = id; let size = 0;
      while (queue.length) { const node = queue.pop()!; size++; for (const from of reverse[node]) if (component[from] < 0) { component[from] = id; queue.push(from); } }
      sizes.push(size);
    }
    const biggest = sizes.indexOf(Math.max(...sizes)), core = new Set<number>();
    for (let node = 0; node < count; node++) if (component[node] === biggest) core.add(node);
    return core;
  }

  /** Metres from a point to the nearest drivable street node (to tell if it's on this map at all). */
  distanceToNetwork(point: Coordinate): number {
    const node = this.nearest(point);
    return node < 0 ? Infinity : metres(this.data.nodes[node], [point.latitude, point.longitude]);
  }

  nearest(point: Coordinate): number {
    let best = -1, bestDistance = Infinity;
    const target: [number, number] = [point.latitude, point.longitude];
    for (const node of this.routable) {
      const distance = metres(this.data.nodes[node], target);
      if (distance < bestDistance) { bestDistance = distance; best = node; }
    }
    return best;
  }

  /**
   * Where a trip may use an avoid street: only the last/first stretch (within AVOID_NEAR_METRES) of the avoid
   * street a stop or the start is on, so a delivery on Knox St is reachable but Knox St is never a shortcut.
   */
  private allowedAvoid(nodes: number[]): Set<string> {
    const allowed = new Set<string>();
    for (const end of nodes) {
      const names = this.nodeNames.get(end) ?? new Set<number>();
      for (const [nameIndex, , , path] of this.data.ways) {
        if (!names.has(nameIndex)) continue;
        for (const node of path) if (metres(this.data.nodes[node], this.data.nodes[end]) <= AVOID_NEAR_METRES) allowed.add(`${nameIndex}:${node}`);
      }
    }
    return allowed;
  }

  /**
   * Cheapest way out of `from` to every node: cost (with preferences) and the edge used to reach each node.
   * Avoid streets are closed except those in `allowedAvoid` (null: all open, the fallback).
   */
  private search(from: number, allowedAvoid: Set<string> | null = null) {
    const cost = new Float64Array(this.data.nodes.length).fill(Infinity);
    const via: Array<Edge | null> = new Array(this.data.nodes.length).fill(null);
    const previous = new Int32Array(this.data.nodes.length).fill(-1);
    const heap = new Heap();
    cost[from] = 0; heap.push(0, from);
    while (heap.size) {
      const [current, node] = heap.pop();
      if (current > cost[node]) continue;
      for (const edge of this.adjacency[node]) {
        if (edge.pref === "avoid" && allowedAvoid && !(allowedAvoid.has(`${edge.name}:${edge.to}`) && allowedAvoid.has(`${edge.name}:${node}`))) continue;
        const next = current + edge.cost;
        if (next < cost[edge.to]) { cost[edge.to] = next; via[edge.to] = edge; previous[edge.to] = node; heap.push(next, edge.to); }
      }
    }
    return { cost, via, previous };
  }

  private leg(search: ReturnType<StreetRouter["search"]>, from: number, to: number): StreetLeg | null {
    if (!Number.isFinite(search.cost[to])) return null;
    const edges: Edge[] = [], nodes: number[] = [to];
    for (let node = to; node !== from; node = search.previous[node]) { edges.push(search.via[node]!); nodes.push(search.previous[node]); }
    edges.reverse(); nodes.reverse();
    const streets: string[] = [];
    for (const edge of edges) { const name = this.data.names[edge.name]; if (name && streets.at(-1) !== name) streets.push(name); }
    const path = nodes.map((node) => this.data.nodes[node]);
    return {
      seconds: edges.reduce((sum, edge) => sum + edge.seconds, 0),
      metres: edges.reduce((sum, edge) => sum + edge.metres, 0),
      stopSigns: edges.filter((edge) => edge.stop).length,
      preferredMetres: edges.filter((edge) => edge.pref === "prefer").reduce((sum, edge) => sum + edge.metres, 0),
      avoidMetres: edges.filter((edge) => edge.pref === "avoid").reduce((sum, edge) => sum + edge.metres, 0),
      path,
      streets,
      steps: driveSteps(path, edges.map((edge) => this.data.names[edge.name])),
    };
  }

  route(from: Coordinate, to: Coordinate): StreetLeg | null {
    const a = this.nearest(from), b = this.nearest(to);
    if (a < 0 || b < 0) return null;
    return this.leg(this.search(a, this.allowedAvoid([a, b])), a, b) ?? this.leg(this.search(a), a, b);
  }

  /** Legs between every pair of points (index 0 is where the run starts). */
  matrix(points: Coordinate[]) {
    const snapped = points.map((point) => this.nearest(point));
    const allowed = this.allowedAvoid(snapped);
    // Closed avoid streets can cut a stop off (one-ways): then that start point searches with everything open.
    const searches = snapped.map((node) => {
      const strict = this.search(node, allowed);
      return snapped.every((target) => Number.isFinite(strict.cost[target])) ? strict : this.search(node);
    });
    return {
      cost: snapped.map((_, i) => snapped.map((node) => searches[i].cost[node])),
      leg: (i: number, j: number) => this.leg(searches[i], snapped[i], snapped[j]),
    };
  }
}

function dueAt(stop: DeliveryRouteStopInput) {
  if (stop.timingMode === "future" && stop.scheduledFor) return new Date(stop.scheduledFor);
  return new Date(new Date(stop.createdAt).getTime() + 45 * 60_000);
}

/** Points along preferred streets where Google Maps should be pinned so it takes the same streets. */
function viaPoints(leg: StreetLeg, router: StreetRouter, limit: number): Array<[number, number]> {
  if (limit <= 0) return [];
  // Walk the path, keeping the midpoint of each long stretch on a preferred street.
  const nodes = leg.path, picks: Array<{ point: [number, number]; length: number }> = [];
  let run: Array<[number, number]> = [];
  const preferredAt = (a: [number, number], b: [number, number]) => {
    for (const [nameIndex, , , path] of router.data.ways) {
      if (router.data.prefs[router.data.names[nameIndex]] !== "prefer") continue;
      for (let i = 1; i < path.length; i++) {
        const p = router.data.nodes[path[i - 1]], q = router.data.nodes[path[i]];
        if ((p === a && q === b) || (p === b && q === a)) return true;
      }
    }
    return false;
  };
  const flush = () => {
    if (run.length > 1) {
      let length = 0; for (let i = 1; i < run.length; i++) length += metres(run[i - 1], run[i]);
      if (length >= 250) picks.push({ point: run[Math.floor(run.length / 2)], length });
    }
    run = [];
  };
  for (let i = 1; i < nodes.length; i++) {
    if (preferredAt(nodes[i - 1], nodes[i])) { if (!run.length) run.push(nodes[i - 1]); run.push(nodes[i]); } else flush();
  }
  flush();
  return picks.toSorted((a, b) => b.length - a.length).slice(0, limit).map((pick) => pick.point)
    .toSorted((a, b) => nodes.indexOf(a) - nodes.indexOf(b));
}

/** Google Maps directions to one address, pinned onto preferred streets along the way (car tablet Navigate). */
export function legNavigationUrl(router: StreetRouter, from: Coordinate, to: Coordinate): string | null {
  if (router.distanceToNetwork(from) > 800 || router.distanceToNetwork(to) > 800) return null;
  const leg = router.route(from, to);
  if (!leg) return null;
  const parameters = new URLSearchParams({ api: "1", travelmode: "driving", destination: `${to.latitude},${to.longitude}` });
  const via = viaPoints(leg, router, 3);
  if (via.length) parameters.set("waypoints", via.map(([lat, lng]) => `${lat},${lng}`).join("|"));
  return `https://www.google.com/maps/dir/?${parameters}`;
}

export type StreetRoutePlan = DeliveryRoutePlan & {
  routed: true;
  /** Driving time for the whole loop back to the deli, drop-offs not included. */
  loopMinutes: number;
  loopMiles: number;
  stopSigns: number;
  preferredShare: number;
  /** The loop as [lat, lng] points, for the dashboard map. */
  path: Array<[number, number]>;
  streets: string[];
};

/**
 * A round trip from the deli: stops in the order that keeps due-soon orders on time and otherwise
 * costs least on the street map (with preferences), improved by 2-opt, then back to the deli.
 */
export function planStreetRoute(input: DeliveryRouteStopInput[], origin: Coordinate, router: StreetRouter, now = new Date(), returnTo: Coordinate | null = origin): StreetRoutePlan | null {
  const stops = input.filter((stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude));
  if (!stops.length) return null;
  const points: Coordinate[] = [origin, ...stops, ...(returnTo ? [returnTo] : [])];
  // Anything off this town's map (out of town, bad geocode): let the straight-line planner handle it.
  if (points.some((point) => router.distanceToNetwork(point) > 800)) return null;
  const { cost, leg } = router.matrix(points);
  const end = returnTo ? points.length - 1 : -1;
  if (stops.some((_, i) => !Number.isFinite(cost[0][i + 1]))) return null;

  // Seconds of driving between two points, for the clock (cost includes preferences, so measure legs).
  const secondsCache = new Map<string, number>();
  const seconds = (i: number, j: number) => {
    const key = `${i}:${j}`;
    if (!secondsCache.has(key)) secondsCache.set(key, leg(i, j)?.seconds ?? Infinity);
    return secondsCache.get(key)!;
  };
  const simulate = (order: number[]) => {
    let clock = now.getTime(), at = 0, late = 0, total = 0;
    const arrivals: number[] = [];
    for (const index of order) {
      clock += seconds(at, index) * 1000; arrivals.push(clock);
      if (clock > dueAt(stops[index - 1]).getTime()) late++;
      total += cost[at][index]; clock += DROP_OFF_MINUTES * 60_000; at = index;
    }
    if (end >= 0) total += cost[at][end];
    return { arrivals, late, total };
  };

  // Greedy: due-soon orders first, otherwise the cheapest next stop.
  const order: number[] = [], left = new Set(stops.map((_, i) => i + 1));
  let at = 0, clock = now.getTime();
  while (left.size) {
    const ranked = [...left].map((index) => {
      const arrival = clock + seconds(at, index) * 1000;
      return { index, arrival, slack: (dueAt(stops[index - 1]).getTime() - arrival) / 60_000, cost: cost[at][index] };
    });
    const urgent = ranked.filter((candidate) => candidate.slack <= 15);
    const next = (urgent.length ? urgent.toSorted((a, b) => a.slack - b.slack || a.cost - b.cost) : ranked.toSorted((a, b) => a.cost - b.cost))[0];
    order.push(next.index); left.delete(next.index);
    clock = next.arrival + DROP_OFF_MINUTES * 60_000; at = next.index;
  }
  // 2-opt: reverse any stretch that makes the loop cheaper without making more orders late.
  let best = simulate(order), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) for (let k = i + 1; k < order.length; k++) {
      const candidate = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
      const result = simulate(candidate);
      if (result.late <= best.late && result.total < best.total - 1) { order.splice(0, order.length, ...candidate); best = result; improved = true; }
    }
  }

  const sequence = [0, ...order, ...(end >= 0 ? [end] : [])];
  const legs = sequence.slice(1).map((to, i) => leg(sequence[i], to)!);
  const planned: DeliveryRouteStop[] = order.map((index, i) => {
    const stop = stops[index - 1], due = dueAt(stop), arrival = new Date(best.arrivals[i]);
    const slack = (due.getTime() - arrival.getTime()) / 60_000;
    return { ...stop, sequence: i + 1, estimatedArrival: arrival.toISOString(), dueAt: due.toISOString(), timingRisk: slack < 0 ? "late" : slack <= 15 ? "due_soon" : "on_track", legMiles: Math.round((legs[i].metres / 1609.34) * 10) / 10 };
  });

  // Google Maps: the stops in order, plus up to 9 waypoints in all, the spare ones pinned on preferred streets.
  const spare = Math.max(0, 9 - planned.length);
  const waypoints: string[] = [];
  legs.forEach((current, i) => {
    for (const [lat, lng] of viaPoints(current, router, Math.floor(spare / legs.length) + (i < spare % legs.length ? 1 : 0))) waypoints.push(`${lat},${lng}`);
    // Several orders for one address (an apartment block) are one stop for Google.
    if (i < planned.length && waypoints.at(-1) !== `${planned[i].latitude},${planned[i].longitude}`) waypoints.push(`${planned[i].latitude},${planned[i].longitude}`);
  });
  const destination = end >= 0 ? `${points[end].latitude},${points[end].longitude}` : waypoints.pop()!;
  const parameters = new URLSearchParams({ api: "1", travelmode: "driving", destination });
  if (waypoints.length) parameters.set("waypoints", waypoints.slice(0, 9).join("|"));

  const totalMetres = legs.reduce((sum, current) => sum + current.metres, 0);
  const streets: string[] = [];
  for (const current of legs) for (const name of current.streets) if (streets.at(-1) !== name) streets.push(name);
  return {
    routed: true,
    stops: planned,
    navigationUrl: `https://www.google.com/maps/dir/?${parameters}`,
    totalStraightLineMiles: Math.round((totalMetres / 1609.34) * 10) / 10,
    urgentStops: planned.filter((stop) => stop.timingRisk !== "on_track").length,
    calculatedAt: now.toISOString(),
    loopMinutes: Math.round(legs.reduce((sum, current) => sum + current.seconds, 0) / 60),
    loopMiles: Math.round((totalMetres / 1609.34) * 10) / 10,
    stopSigns: legs.reduce((sum, current) => sum + current.stopSigns, 0),
    preferredShare: totalMetres ? Math.round((legs.reduce((sum, current) => sum + current.preferredMetres, 0) / totalMetres) * 100) : 0,
    path: legs.flatMap((current, i) => (i ? current.path.slice(1) : current.path)),
    streets,
  };
}
