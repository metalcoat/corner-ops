/*
 * Deli Man pixel art (facing right). Frames are assembled from a shared head,
 * a torso pose and a leg pose so the run cycle stays on-model.
 * Palette letters come from PAL; B/b are swapped for the equipped weapon.
 */

const HEAD = [
  "........KKKKKK",
  "......KKRRRRRRKK",
  ".....KRRRRWWRRRRK",
  "....KRRRRWGGWRRRRK",
  "....KRRRRRWWRRRRRRKK",
  "....KrrrrrrrrrrrrrrrK",
  "....KNSSSSSSSSKKKKKK",
  "....KNSSSSSWWSWWK",
  "....KNSSSSSWKSWKK",
  "....KNSSSSSWKSWKK",
  "....KsSSSSSSSSSSK",
  ".....KsSSSSSSKKSK",
  "......KKsSSSSSKK",
];

const HEAD_HURT = [
  ...HEAD.slice(0, 7),
  "....KNSSSSSKSSKSK",
  "....KNSSSSSSKSSKK",
  "....KNSSSSSKSSKSK",
  "....KsSSSSSSSSSSK",
  ".....KsSSSSSKWKSK",
  "......KKsSSSSSKK",
];

const TORSO_IDLE = [
  "...KKBBKWWWWWWWWKBBKK",
  "..KBBBBKWWWGGWWWKBBBBK",
  "..KBBBBKWWWWWWWWKBBBBK",
  "..KSSSKKWWWWWWWWKKSSSK",
  "...KKK.KbbbbbbbbK.KKK",
];

const TORSO_RUN = [
  "....KBBKWWWWWWWWKBBK",
  "..KKBBBKWWWGGWWWKBBBKK",
  "KSSBBBKKWWWWWWWWKKBBBSSK",
  "KSSKKK.KWWWWWWWWK.KKKSSK",
  ".KK....KbbbbbbbbK....KK",
];

const TORSO_JUMP = [
  "KK..KBBKWWWWWWWWKBBK..KK",
  "KSKKBBBKWWWGGWWWKBBBKKSK",
  "KSBBBBKKWWWWWWWWKKBBBBSK",
  ".KKKKK.KWWWWWWWWK.KKKKK",
  ".......KbbbbbbbbK",
];

const LEGS_IDLE = [
  ".......KBBBKKBBBK",
  "......KBBBBK.KBBBBK",
  "......KBBBBK.KBBBBK",
  ".....KbbbbbK.KbbbbbK",
  "....KbbbbbbK.KbbbbbbK",
  "....KKKKKKKK.KKKKKKKK",
];

const LEGS_RUN1 = [
  ".......KBBBBBBBBK",
  "......KBBBKKKBBBBK",
  ".....KBBBK..KBBBBBK",
  "...KKbbbK....KbbbbbK",
  "..KbbbbK.....KbbbbbbK",
  "..KKKKK......KKKKKKKK",
];

const LEGS_RUN2 = [
  ".......KBBBBBBBBK",
  "........KBBBBBBK",
  "........KBBBBBK",
  ".......KbbbbbbK",
  ".......KbbbbbbbK",
  ".......KKKKKKKKK",
];

const LEGS_RUN3 = [
  ".......KBBBBBBBBK",
  "......KBBBBKKBBBK",
  ".....KBBBBK..KBBBK",
  "....KbbbbbK...KbbbKK",
  "...KbbbbbbK....KbbbbK",
  "...KKKKKKKK.....KKKKK",
];

const LEGS_JUMP = [
  ".......KBBBBBBBBK",
  "......KBBBBKKBBBBK",
  ".....KBBBBK.KBBBBK",
  "....KbbbbbK..KbbbbbK",
  "....KbbbbbK...KbbbbbK",
  "....KKKKKK.....KKKKKK",
];

export const CLIMB = [
  "..KK.....KKKKKK",
  ".KSSK..KKRRRRRRKK",
  ".KSSK.KRRRRRRRRRRK",
  ".KBBKKRRRRRRRRRRRRK",
  ".KBBKKRRRRRRRRRRRRK",
  ".KBBKKrrrrrrrrrrrrK",
  ".KBBKKNNNNNNNNNNNNK",
  ".KBBKKNNNNNNNNNNNNK",
  ".KBBKKNNNNNNNNNNNNK",
  ".KBBKKsNNNNNNNNNNsK",
  ".KBBK.KsNNNNNNNNsK",
  ".KBBK..KKNNNNNNKK",
  ".KBBKKKKKKKKKKKKKKK",
  "..KBBBKBBBBBBBBBBKBBK",
  "...KBBKBBBBBBBBBBKBBK",
  "....KKKBBBBBBBBBBKBBK",
  "......KBBBBBBBBBBKSSK",
  "......KbbbbbbbbbbKKK",
  "......KBBBBKKBBBBK",
  "......KBBBBK.KBBBBK",
  "......KBBBBK..KbbbK",
  ".....KbbbbbK..KbbbK",
  ".....KbbbbbK...KKK",
  ".....KKKKKKK",
];

/** Sub-sandwich arm cannon stamped over the front arm while shooting. */
const CANNON = [
  "KKKKKKKKKKK",
  "BBKTTTTTTTTK",
  "BBKGRGRGRGRK",
  "BBKttttttttK",
  "KKKKKKKKKKK",
];

export const FRAME_W = 32;
export const FRAME_H = 24;
/** Column of the body's centre inside a right-facing frame. */
export const ANCHOR_X = 12;
/** Muzzle position inside a right-facing frame (shooting pose). */
export const MUZZLE = { x: 28, y: 15 };

function assemble(head: string[], torso: string[], legs: string[], shoot: boolean) {
  const rows = [...head, ...torso, ...legs].map((row) =>
    row.padEnd(FRAME_W, ".").slice(0, FRAME_W).split(""),
  );
  if (shoot) {
    for (let y = 13; y <= 17; y++)
      for (let x = 16; x < FRAME_W; x++) rows[y][x] = ".";
    CANNON.forEach((line, dy) =>
      line.split("").forEach((ch, dx) => {
        if (ch !== ".") rows[13 + dy][16 + dx] = ch;
      }),
    );
  }
  return rows.map((row) => row.join(""));
}

export type PlayerPose =
  | "idle"
  | "run1"
  | "run2"
  | "run3"
  | "jump"
  | "hurt"
  | "climb";

const frames = new Map<string, string[]>();

export function playerFrame(pose: PlayerPose, shoot: boolean): string[] {
  const key = `${pose}:${shoot}`;
  let rows = frames.get(key);
  if (!rows) {
    rows = buildFrame(pose, shoot);
    frames.set(key, rows);
  }
  return rows;
}

function buildFrame(pose: PlayerPose, shoot: boolean): string[] {
  switch (pose) {
    case "idle":
      return assemble(HEAD, TORSO_IDLE, LEGS_IDLE, shoot);
    case "run1":
      return assemble(HEAD, TORSO_RUN, LEGS_RUN1, shoot);
    case "run2":
      return assemble(HEAD, TORSO_RUN, LEGS_RUN2, shoot);
    case "run3":
      return assemble(HEAD, TORSO_RUN, LEGS_RUN3, shoot);
    case "jump":
      return assemble(HEAD, TORSO_JUMP, LEGS_JUMP, shoot);
    case "hurt":
      return assemble(HEAD_HURT, TORSO_JUMP, LEGS_JUMP, false);
    case "climb":
      return shoot
        ? assemble(HEAD, TORSO_IDLE, LEGS_IDLE, true)
        : CLIMB.map((row) => row.padEnd(FRAME_W, "."));
  }
}

/** Head-only icon used for the 1-UP pickup and lives counter. */
export const HEAD_ICON = HEAD.slice(0, 13).map((row) => row.slice(3, 21));
