// Stale draft alert: staff orders nobody sent to the kitchen. Pure, so it is unit-tested.
export const STALE_DRAFT_SNOOZE_MINUTES = 5;
export type StaleDraftSettings = { minutes: number; stations: string[] };

export function parseStaleDraftSettings(input: { minutes?: unknown; stations?: unknown }): StaleDraftSettings {
  const minutes = Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) throw new Error("Minutes must be a whole number from 0 (off) to 240.");
  if (!Array.isArray(input.stations)) throw new Error("Choose which POS stations show the alert.");
  return { minutes, stations: [...new Set(input.stations.map((key) => String(key).trim().toLowerCase()).filter(Boolean))] };
}

export function stationShowsStaleDrafts(settings: StaleDraftSettings, stationKey: string) {
  return settings.minutes > 0 && settings.stations.includes(stationKey.trim().toLowerCase());
}

export function draftAgeLabel(startedAt: string | Date, now: Date) {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ${minutes % 60} min ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}
