import { STAGES } from "./deli-man-data";

export const DELI_MAN_SAVE_KEY = "deli-man-save-v2";
export const DELI_MAN_SAVE_VERSION = 2;

export type DeliManSave = {
  version: number;
  completedStages: string[];
  weapons: string[];
  upgrades: string[];
  secrets: string[];
  worldFlags: string[];
  bestScores: Record<string, number>;
  lastStage: string | null;
};

export type StageRoom = {
  id: string;
  name: string;
  column: number;
  row: number;
  exits: string[];
  kind: "entry" | "combat" | "vertical" | "secret" | "checkpoint" | "boss";
};

const EMPTY_SAVE: DeliManSave = {
  version: DELI_MAN_SAVE_VERSION,
  completedStages: [],
  weapons: [],
  upgrades: [],
  secrets: [],
  worldFlags: [],
  bestScores: {},
  lastStage: null,
};

export function loadDeliManSave(): DeliManSave {
  if (typeof window === "undefined") return { ...EMPTY_SAVE };
  try {
    const current = JSON.parse(
      localStorage.getItem(DELI_MAN_SAVE_KEY) || "null",
    ) as Partial<DeliManSave> | null;
    if (current?.version === DELI_MAN_SAVE_VERSION) {
      return {
        ...EMPTY_SAVE,
        ...current,
        completedStages: [...new Set(current.completedStages || [])],
        weapons: [...new Set(current.weapons || [])],
        upgrades: [...new Set(current.upgrades || [])],
        secrets: [...new Set(current.secrets || [])],
        worldFlags: [...new Set(current.worldFlags || [])],
        bestScores: current.bestScores || {},
      };
    }

    // Migrate the original object-shaped save without trusting unknown fields.
    const legacy = JSON.parse(
      localStorage.getItem("deli-man-save") || "{}",
    ) as Record<string, unknown>;
    const completedStages = STAGES.filter(
      (stage) => legacy[stage.id] === true,
    ).map((stage) => stage.id);
    const weapons = STAGES.filter(
      (stage) => legacy[stage.ability] === true,
    ).map((stage) => stage.ability);
    return { ...EMPTY_SAVE, completedStages, weapons };
  } catch {
    return { ...EMPTY_SAVE };
  }
}

export function writeDeliManSave(save: DeliManSave) {
  localStorage.setItem(
    DELI_MAN_SAVE_KEY,
    JSON.stringify({ ...save, version: DELI_MAN_SAVE_VERSION }),
  );
}

export function completeDeliManStage(
  stageId: string,
  ability: string,
  score: number,
) {
  const save = loadDeliManSave();
  save.completedStages = [...new Set([...save.completedStages, stageId])];
  save.weapons = [...new Set([...save.weapons, ability])];
  save.worldFlags = [...new Set([...save.worldFlags, `${stageId}:restored`])];
  save.bestScores[stageId] = Math.max(save.bestScores[stageId] || 0, score);
  save.lastStage = stageId;
  writeDeliManSave(save);
  window.dispatchEvent(new CustomEvent("deli-man-save", { detail: save }));
  return save;
}

export function buildStageRooms(stageId: string): StageRoom[] {
  return [
    {
      id: `${stageId}:entry`,
      name: "ENTRY",
      column: 0,
      row: 1,
      exits: [`${stageId}:line`],
      kind: "entry",
    },
    {
      id: `${stageId}:line`,
      name: "MAIN LINE",
      column: 1,
      row: 1,
      exits: [`${stageId}:entry`, `${stageId}:shaft`, `${stageId}:secret`],
      kind: "combat",
    },
    {
      id: `${stageId}:secret`,
      name: "SERVICE ACCESS",
      column: 1,
      row: 0,
      exits: [`${stageId}:line`],
      kind: "secret",
    },
    {
      id: `${stageId}:shaft`,
      name: "VERTICAL ROUTE",
      column: 2,
      row: 1,
      exits: [`${stageId}:line`, `${stageId}:checkpoint`],
      kind: "vertical",
    },
    {
      id: `${stageId}:checkpoint`,
      name: "BOSS APPROACH",
      column: 3,
      row: 1,
      exits: [`${stageId}:shaft`, `${stageId}:boss`],
      kind: "checkpoint",
    },
    {
      id: `${stageId}:boss`,
      name: "BOSS",
      column: 4,
      row: 1,
      exits: [`${stageId}:checkpoint`],
      kind: "boss",
    },
  ];
}
