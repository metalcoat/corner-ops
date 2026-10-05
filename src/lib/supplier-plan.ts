// Supplier cost planning: compare what each supplier charges for what the deli
// actually uses, then find the cheapest way to split an order across suppliers
// while respecting each one's order minimum, delivery fee, and delivery days.
// Pure functions (no database) so the math is unit-tested.

type Dimension = "each" | "weight" | "volume";
const UNITS: Record<string, { dimension: Dimension; factor: number }> = {
  each: { dimension: "each", factor: 1 }, ea: { dimension: "each", factor: 1 }, count: { dimension: "each", factor: 1 },
  ct: { dimension: "each", factor: 1 }, pc: { dimension: "each", factor: 1 }, piece: { dimension: "each", factor: 1 },
  slice: { dimension: "each", factor: 1 }, roll: { dimension: "each", factor: 1 }, loaf: { dimension: "each", factor: 1 },
  can: { dimension: "each", factor: 1 }, bottle: { dimension: "each", factor: 1 }, bag: { dimension: "each", factor: 1 },
  dozen: { dimension: "each", factor: 12 }, dz: { dimension: "each", factor: 12 },
  oz: { dimension: "weight", factor: 1 }, ounce: { dimension: "weight", factor: 1 },
  lb: { dimension: "weight", factor: 16 }, pound: { dimension: "weight", factor: 16 },
  g: { dimension: "weight", factor: 0.035274 }, gram: { dimension: "weight", factor: 0.035274 },
  kg: { dimension: "weight", factor: 35.274 },
  floz: { dimension: "volume", factor: 29.5735 }, ml: { dimension: "volume", factor: 1 },
  l: { dimension: "volume", factor: 1000 }, liter: { dimension: "volume", factor: 1000 }, litre: { dimension: "volume", factor: 1000 },
  cup: { dimension: "volume", factor: 236.588 }, pt: { dimension: "volume", factor: 473.176 }, pint: { dimension: "volume", factor: 473.176 },
  qt: { dimension: "volume", factor: 946.353 }, quart: { dimension: "volume", factor: 946.353 },
  gal: { dimension: "volume", factor: 3785.41 }, gallon: { dimension: "volume", factor: 3785.41 },
};

function unitKey(unit: string) {
  const key = unit.trim().toLowerCase().replace(/[.\s]/g, "").replace(/^fl(uid)?oz$/, "floz");
  if (UNITS[key]) return key;
  const singular = key.replace(/(es|s)$/, "");
  return UNITS[singular] ? singular : UNITS[key.replace(/s$/, "")] ? key.replace(/s$/, "") : key;
}

/** Converts between units of the same kind (lb ↔ oz, gal ↔ qt, dozen ↔ each); null if they don't mix. */
export function convertUnits(value: number, from: string, to: string): number | null {
  const a = unitKey(from), b = unitKey(to);
  if (a === b) return value;
  const x = UNITS[a], y = UNITS[b];
  if (!x || !y || x.dimension !== y.dimension) return null;
  return (value * x.factor) / y.factor;
}

export type SupplierTerms = {
  id: string;
  name: string;
  minimumOrderCents: number;
  deliveryFeeCents: number;
  /** Delivery fee is waived at or above this order size. */
  freeDeliveryOverCents: number | null;
  /** Truck days, 0 = Sunday … 6 = Saturday. */
  deliveryDays: number[];
  /** Order-by time ("16:00") on the day that is `cutoffDaysBefore` days ahead of delivery. */
  cutoffTime: string;
  cutoffDaysBefore: number;
  /** Shipped suppliers (e.g. WebstaurantStore): business days from order to door. Used when there are no truck days. */
  shipsInDays: number | null;
};

export type Offer = {
  supplierId: string;
  itemId: string;
  caseQuantity: number;
  caseUnit: string;
  casePriceCents: number;
};

export type DeliveryWindow = { orderBy: string | null; deliveryDate: string };

const TZ = "America/New_York";
function localParts(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}
/** The instant a wall-clock time in New York happens. */
function zoned(year: number, month: number, day: number, hour: number, minute: number) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(instant));
    instant += guess - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(instant);
}
const isoDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** The next delivery you can still make, and when you have to order by. */
export function nextDelivery(terms: Pick<SupplierTerms, "deliveryDays" | "cutoffTime" | "cutoffDaysBefore" | "shipsInDays">, now = new Date()): DeliveryWindow | null {
  const today = localParts(now);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  const days = [...new Set(terms.deliveryDays.filter((day) => day >= 0 && day <= 6))];
  if (days.length) {
    const [hour, minute] = (/^(\d{1,2}):(\d{2})$/.exec(terms.cutoffTime || "") || ["", "16", "00"]).slice(1).map(Number);
    for (let ahead = 0; ahead <= 21; ahead++) {
      const date = new Date(base + ahead * 86_400_000);
      if (!days.includes(date.getUTCDay())) continue;
      const cutoff = new Date(date.getTime() - Math.max(0, terms.cutoffDaysBefore) * 86_400_000);
      const orderBy = zoned(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, cutoff.getUTCDate(), hour, minute);
      if (orderBy.getTime() > now.getTime()) return { orderBy: orderBy.toISOString(), deliveryDate: date.toISOString().slice(0, 10) };
    }
    return null;
  }
  if (terms.shipsInDays != null && terms.shipsInDays >= 0) {
    let remaining = Math.ceil(terms.shipsInDays), cursor = base;
    while (remaining > 0 || [0, 6].includes(new Date(cursor).getUTCDay())) {
      cursor += 86_400_000;
      if (![0, 6].includes(new Date(cursor).getUTCDay())) remaining--;
    }
    const d = new Date(cursor);
    return { orderBy: null, deliveryDate: isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) };
  }
  return null;
}

/** Cost of one base unit (e.g. one lb) from this offer, in cents; null if the case unit can't convert. */
export function unitCostCents(offer: Offer, baseUnit: string): number | null {
  const perCase = convertUnits(offer.caseQuantity, offer.caseUnit, baseUnit);
  if (!perCase || perCase <= 0 || offer.casePriceCents <= 0) return null;
  return offer.casePriceCents / perCase;
}

/** Whole cases needed to cover `need` base units (at least one when anything is needed). */
export function casesFor(need: number, offer: Offer, baseUnit: string): number | null {
  const perCase = convertUnits(offer.caseQuantity, offer.caseUnit, baseUnit);
  if (!perCase || perCase <= 0) return null;
  return need > 0 ? Math.max(1, Math.ceil(need / perCase - 1e-9)) : 0;
}

export type PlanItem = { id: string; name: string; baseUnit: string; need: number; runOutDate?: string | null };
export type PlanLine = { itemId: string; name: string; cases: number; casePriceCents: number; costCents: number; unitCostCents: number; late: boolean };
export type SupplierOrder = {
  supplierId: string;
  name: string;
  lines: PlanLine[];
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  minimumOrderCents: number;
  shortOfMinimumCents: number;
  delivery: DeliveryWindow | null;
};
export type Plan = {
  label: string;
  orders: SupplierOrder[];
  totalCents: number;
  feesCents: number;
  /** Items this plan can't buy (no price from these suppliers). */
  missing: string[];
  meetsMinimums: boolean;
  lateItems: number;
};

type Choice = { offer: Offer; cases: number; cost: number; unit: number; late: boolean };

function choicesFor(item: PlanItem, offers: Offer[], windows: Map<string, DeliveryWindow | null>) {
  const out = new Map<string, Choice>();
  for (const offer of offers) {
    if (offer.itemId !== item.id) continue;
    const cases = casesFor(item.need, offer, item.baseUnit), unit = unitCostCents(offer, item.baseUnit);
    if (cases == null || unit == null) continue;
    const date = windows.get(offer.supplierId)?.deliveryDate;
    const late = Boolean(item.runOutDate && (!date || date > item.runOutDate));
    const choice = { offer, cases, cost: cases * offer.casePriceCents, unit, late };
    const current = out.get(offer.supplierId);
    if (!current || choice.cost < current.cost) out.set(offer.supplierId, choice);
  }
  return out;
}
/** Cheapest on-time option, else cheapest late one. */
function pick(choices: Choice[]) {
  const onTime = choices.filter((choice) => !choice.late);
  return (onTime.length ? onTime : choices).toSorted((a, b) => a.cost - b.cost || a.unit - b.unit)[0];
}

function buildPlan(label: string, supplierIds: string[], items: PlanItem[], options: Map<string, Map<string, Choice>>, suppliers: Map<string, SupplierTerms>, windows: Map<string, DeliveryWindow | null>, enforceMinimums: boolean): Plan | null {
  const assigned = new Map<string, Choice>(), missing: string[] = [];
  for (const item of items) {
    const choices = supplierIds.map((id) => options.get(item.id)?.get(id)).filter((choice): choice is Choice => Boolean(choice));
    if (!choices.length) missing.push(item.id);
    else assigned.set(item.id, pick(choices));
  }
  const subtotal = (supplierId: string) => [...assigned.values()].filter((c) => c.offer.supplierId === supplierId).reduce((sum, c) => sum + c.cost, 0);
  if (enforceMinimums) {
    // Top a supplier up to its minimum by moving over the items that cost the least extra to switch.
    for (const supplierId of supplierIds) {
      const minimum = suppliers.get(supplierId)!.minimumOrderCents;
      while (subtotal(supplierId) < minimum) {
        const moves = [...assigned.entries()]
          .filter(([, choice]) => choice.offer.supplierId !== supplierId)
          .map(([itemId, choice]) => {
            const alternative = options.get(itemId)?.get(supplierId);
            const from = choice.offer.supplierId;
            const fromMinimum = suppliers.get(from)!.minimumOrderCents;
            // Don't pull a supplier we already topped up back under its own minimum.
            const breaks = subtotal(from) - choice.cost < fromMinimum && supplierIds.indexOf(from) < supplierIds.indexOf(supplierId);
            return alternative && !breaks ? { itemId, alternative, extra: alternative.cost - choice.cost } : null;
          })
          .filter((move): move is NonNullable<typeof move> => Boolean(move))
          .sort((a, b) => a.extra - b.extra);
        if (!moves.length) break;
        assigned.set(moves[0].itemId, moves[0].alternative);
      }
    }
  }
  const byName = new Map(items.map((item) => [item.id, item.name]));
  const orders: SupplierOrder[] = [];
  for (const supplierId of supplierIds) {
    const terms = suppliers.get(supplierId)!;
    const lines = [...assigned.entries()]
      .filter(([, choice]) => choice.offer.supplierId === supplierId)
      .map(([itemId, c]) => ({ itemId, name: byName.get(itemId) || "", cases: c.cases, casePriceCents: c.offer.casePriceCents, costCents: c.cost, unitCostCents: Math.round(c.unit * 100) / 100, late: c.late }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!lines.length) {
      if (enforceMinimums) return null; // same as a plan without this supplier
      continue;
    }
    const sub = lines.reduce((sum, line) => sum + line.costCents, 0);
    const fee = terms.freeDeliveryOverCents != null && sub >= terms.freeDeliveryOverCents ? 0 : terms.deliveryFeeCents;
    orders.push({ supplierId, name: terms.name, lines, subtotalCents: sub, feeCents: fee, totalCents: sub + fee, minimumOrderCents: terms.minimumOrderCents, shortOfMinimumCents: Math.max(0, terms.minimumOrderCents - sub), delivery: windows.get(supplierId) ?? null });
  }
  return {
    label,
    orders,
    totalCents: orders.reduce((sum, order) => sum + order.totalCents, 0),
    feesCents: orders.reduce((sum, order) => sum + order.feeCents, 0),
    missing,
    meetsMinimums: orders.every((order) => order.shortOfMinimumCents === 0),
    lateItems: orders.reduce((sum, order) => sum + order.lines.filter((line) => line.late).length, 0),
  };
}

export type SupplierAnalysis = {
  best: Plan | null;
  /** Everything from one supplier, for comparison. */
  single: Plan[];
  /** Lowest price for every item ignoring minimums and fees: the floor. */
  floorCents: number;
  windows: Record<string, DeliveryWindow | null>;
};

/**
 * Tries every combination of suppliers (there are only a handful), buys each
 * item from the cheapest supplier in the combination that can deliver before it
 * runs out, tops suppliers up to their minimums, and keeps the cheapest plan
 * that buys the most items.
 */
export function analyzeSuppliers(items: PlanItem[], offers: Offer[], supplierList: SupplierTerms[], now = new Date()): SupplierAnalysis {
  const needed = items.filter((item) => item.need > 0);
  const suppliers = new Map(supplierList.map((s) => [s.id, s]));
  const windows = new Map(supplierList.map((s) => [s.id, nextDelivery(s, now)]));
  const options = new Map(needed.map((item) => [item.id, choicesFor(item, offers.filter((o) => suppliers.has(o.supplierId)), windows)]));
  const usable = supplierList.filter((s) => needed.some((item) => options.get(item.id)?.has(s.id))).slice(0, 10);

  const rank = (plan: Plan) => [plan.missing.length, plan.meetsMinimums ? 0 : 1, plan.lateItems, plan.totalCents];
  const better = (a: Plan, b: Plan | null) => {
    if (!b) return true;
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  };
  let best: Plan | null = null;
  for (let mask = 1; mask < 1 << usable.length; mask++) {
    const ids = usable.filter((_, i) => mask & (1 << i)).map((s) => s.id);
    const plan = buildPlan(ids.map((id) => suppliers.get(id)!.name).join(" + "), ids, needed, options, suppliers, windows, true);
    if (plan && better(plan, best)) best = plan;
  }
  const single = usable
    .map((s) => buildPlan(`Everything from ${s.name}`, [s.id], needed, options, suppliers, windows, false)!)
    .sort((a, b) => a.missing.length - b.missing.length || a.totalCents - b.totalCents);
  const floorCents = needed.reduce((sum, item) => {
    const choices = [...(options.get(item.id)?.values() ?? [])];
    return sum + (choices.length ? Math.min(...choices.map((c) => c.cost)) : 0);
  }, 0);
  return { best, single, floorCents, windows: Object.fromEntries(windows) };
}
