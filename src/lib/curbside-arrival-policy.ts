/** Curbside check-in: pure rules shared by the customer page, the API and the greeter TV. */

export const CAR_COLORS = ["White", "Black", "Silver", "Gray", "Red", "Blue", "Green", "Brown", "Tan", "Other"] as const;
export const CAR_TYPES = ["Car", "SUV", "Truck", "Van", "Other"] as const;
/** A checked-in customer stays on the TV until the order is finished, or this long at most. */
export const CURBSIDE_SHOW_MINUTES = 20;
/** Orders the kitchen is working on or has finished; a customer can check in on these. */
export const CURBSIDE_CHECK_IN_STATUSES = ["sent_to_kitchen", "in_progress", "ready"];

export function parseCurbsideArrival(body: unknown): { carColor: string; carType: string } {
  const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const carColor = String(value.carColor ?? ""), carType = String(value.carType ?? "");
  if (!(CAR_COLORS as readonly string[]).includes(carColor)) throw new Error("Choose your car's color.");
  if (!(CAR_TYPES as readonly string[]).includes(carType)) throw new Error("Choose your type of car.");
  return { carColor, carType };
}

/** "Silver SUV", or just the part that's known when the customer picked "Other". */
export function carLabel(color: string, type: string): string {
  const parts = [color === "Other" ? "" : color, type === "Other" ? "" : type].filter(Boolean);
  return parts.join(" ") || "Car";
}

/** Ids to ring for: new since the last poll. The first poll only notes what's already showing. */
export function newArrivals(state: { initialized: boolean; seen: Set<number> }, ids: readonly number[]): number[] {
  const fresh = state.initialized ? ids.filter((id) => !state.seen.has(id)) : [];
  state.initialized = true;
  for (const id of ids) state.seen.add(id);
  return fresh;
}
