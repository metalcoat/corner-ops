import { BOSSES, WEAPON_ORDER, type BossId, type WeaponId } from "./data";

/** Progress is kept per-browser, like a battery save. Older v2 saves are ignored. */
const KEY = "deli-man-save-v3";

export type DeliManSave = {
  defeated: BossId[];
  cleared: boolean;
};

const EMPTY: DeliManSave = { defeated: [], cleared: false };

export function loadSave(): DeliManSave {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<DeliManSave> | null;
    if (!raw || !Array.isArray(raw.defeated)) return { ...EMPTY, defeated: [] };
    const defeated = [...new Set(raw.defeated)].filter((id): id is BossId => id in BOSSES);
    return { defeated, cleared: raw.cleared === true };
  } catch {
    return { ...EMPTY, defeated: [] };
  }
}

export function writeSave(save: DeliManSave) {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* storage unavailable (private mode) — progress lasts for the session */
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function weaponsFor(save: DeliManSave): WeaponId[] {
  const earned = new Set(save.defeated.map((id) => BOSSES[id].weapon));
  return WEAPON_ORDER.filter((weapon) => weapon === "buster" || earned.has(weapon));
}
