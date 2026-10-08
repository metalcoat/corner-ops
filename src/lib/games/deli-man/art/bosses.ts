/*
 * "Robot master" parody bosses share one body plan (facing LEFT) with a
 * unique 16x12 helmet/head per boss, just like the NES-era roster.
 * Body letters: A = primary, a = secondary, Z = accent.
 */

const BODY_STAND = [
  "....KKKKKKKKKKKKKKKK....",
  "..KKaaKAAAAAAAAAAKaaKK..",
  ".KaaaaKAAAAZZAAAAKaaaaK.",
  ".KaaaaKAAAZZZZAAAKaaaaK.",
  ".KSSSKKAAAAZZAAAAKKSSSK.",
  "..KKKK.KaaaaaaaaaK.KKKK.",
  "......KAAAAKKAAAAK......",
  ".....KAAAAAK.KAAAAAK....",
  ".....KAAAAAK.KAAAAAK....",
  "....KaaaaaaK.KaaaaaaK...",
  "...KaaaaaaaK.KaaaaaaaK..",
  "...KKKKKKKKK.KKKKKKKKK..",
];

const BODY_JUMP = [
  "KK..KKKKKKKKKKKKKKKK..KK",
  "KSKKaaKAAAAAAAAAAKaaKKSK",
  "KSaaaaKAAAAZZAAAAKaaaaSK",
  ".KaaaKKAAAZZZZAAAKKaaaK.",
  "..KKK.KAAAAZZAAAAK.KKK..",
  "......KaaaaaaaaaaK......",
  ".....KAAAAAKKAAAAAK.....",
  "....KAAAAAK..KAAAAAK....",
  "...KaaaaaK....KaaaaaK...",
  "...KaaaaaK....KaaaaaK...",
  "...KKKKKK......KKKKKK...",
  "........................",
];

const BODY_THROW = [
  "....KKKKKKKKKKKKKKKK....",
  "KKKKKaKAAAAAAAAAAKaaKK..",
  "KSSaaaKAAAAZZAAAAKaaaaK.",
  "KSSaaaKAAAZZZZAAAKaaaaK.",
  "KKKKKKKAAAAZZAAAAKKSSSK.",
  ".......KaaaaaaaaaK.KKKK.",
  "......KAAAAKKAAAAK......",
  ".....KAAAAAK..KAAAAK....",
  "....KAAAAAK....KAAAAK...",
  "...KaaaaaaK....KaaaaaK..",
  "..KaaaaaaaK...KaaaaaaaK.",
  "..KKKKKKKKK...KKKKKKKKK.",
];

export const BOSS_HEADS: Record<string, string[]> = {
  pothole: [
    "......KKKK......",
    ".....KOOOOK.....",
    ".....KWWWWK.....",
    "....KOOOOOOK....",
    "..KKKWWWWWWKKK..",
    ".KaaaaaKaaaaaaK.",
    ".KaKSSSSSSSSKaK.",
    ".KaKSWWSSWWSKaK.",
    ".KaKSKWSSKWSKaK.",
    ".KaKSSSSSSSSKaK.",
    "..KKKSKKKKSKKK..",
    "....KKSSSSKK....",
  ],
  snowbank: [
    "....KKKKKKKK....",
    "..KKWWWWWWWWKK..",
    ".KWWWWLWWWWWWWK.",
    "KWWLWWWWWWLWWWWK",
    "KWWWWWWWWWWWWWLK",
    "KLWKKKKKKKKKKWWK",
    "KWKSSSSSSSSSSKLK",
    "KLKSWWSSSSWWSKWK",
    ".KKSKWSSSSKWSKK.",
    "..KSSSSSSSSSSK..",
    "..KRRRRRRRRRRK..",
    "...KKRRKKRRKK...",
  ],
  deer: [
    "K.K.K......K.K.K",
    "KNKNK......KNKNK",
    ".KNNK.KKKK.KNNK.",
    "..KNNKNNNNKNNK..",
    "KK.KNNNNNNNNK.KK",
    "KNKKNNNNNNNNKKNK",
    ".KNKNWWNNWWNKNK.",
    "..KNNKWNNKWNNK..",
    "...KNNNNNNNNK...",
    "...KNNyyyyNNK...",
    "....KNyKKyNK....",
    ".....KKKKKK.....",
  ],
  goose: [
    "......KKKK......",
    ".....KddddK.....",
    "..KKKddWddK.....",
    ".KggKddddddK....",
    "..KKKKddddK.....",
    "...KKddddddKK...",
    "..KddddddddddK..",
    ".KWWKSSSSSSKWWK.",
    ".KWKSWWSSWWSKWK.",
    ".KWKSKWSSKWSKWK.",
    ".KWWKSSSSSSKWWK.",
    "..KKKKSKKKSKKK..",
  ],
  coupon: [
    "...KK......KK...",
    "..KwwK....KwwK..",
    "...KwwK..KwwK...",
    "....KwwKKwwK....",
    ".....KKggKK.....",
    "..KKKKKggKKKKK..",
    ".KYKYKYKYKYKYKK.",
    ".KYKSSSSSSSSKYK.",
    ".KKKSWWSSWWSKKK.",
    ".KYKSKWSSKWSKYK.",
    ".KKKSSSSSSSSKKK.",
    "..KKKSKKKKSKKK..",
  ],
  complaint: [
    "....KKKKKKKK....",
    "..KKyyyyyyyyKK..",
    ".KyyyyyyyyyyyyK.",
    "KyyYyyyyyyyYyyyK",
    "KyyyKKKKKKKKyyyK",
    "KyyKKgKKKKgKKyyK",
    "KyyKSSSSSSSSKyyK",
    "KyyKSKKSSKKSKyK.",
    ".KyKSWKSSKWSKyK.",
    ".KyKSSSSSSSSKK..",
    "..KKSKKKKKKSK...",
    "....KKSSSSKK....",
  ],
  admin: [
    "..KKKKKKKKKKK...",
    ".KWWWWWWWWWWWK..",
    ".KWKKWKKWKKWWK..",
    ".KWWWWWWWWWWWK..",
    "..KKKWKKKKKKKK..",
    "..KAAKAAAAAAAAK.",
    ".KAAAAAAAAAAAAK.",
    ".KAKSSSSSSSSKAK.",
    ".KAKSWWSSWWSKAK.",
    ".KAKSKWSSKWSKAK.",
    ".KAKSSSKKSSSKAK.",
    "..KKKKSSSSKKKK..",
  ],
  slasher: [
    ".......KK.......",
    "......KwwK......",
    ".....KwwwwK.....",
    ".....KwWwwK.....",
    "....KKwwwwKK....",
    "..KKRRKKKKRRKK..",
    ".KRRRRRRRRRRRRK.",
    ".KRKSSSSSSSSKRK.",
    ".KRKSWWSSWWSKRK.",
    ".KRKSKKSSKKSKRK.",
    ".KRKSSSSSSSSKRK.",
    "..KKKSSKKSSKKK..",
  ],
  margin: [
    "....KKKKKKKK....",
    "...KSSSSSSSSK...",
    "..KSSWSSSSSSSK..",
    "..KSSSSSSSSSSK..",
    ".KnKSSSSSSSSKnK.",
    ".KnKKKKSSKKKKnK.",
    ".KSKWWKKKKWWKSK.",
    ".KSKKWKSSKYYKSK.",
    "..KSSSSSSSSSSK..",
    "..KSnnnnnnnnSK..",
    "...KSSKKKKSSK...",
    "....KKKKKKKK....",
  ],
};

export type BossPose = "stand" | "jump" | "throw";

const frames = new Map<string, string[]>();

export function bossFrame(head: string, pose: BossPose): string[] {
  const key = `${head}:${pose}`;
  const hit = frames.get(key);
  if (hit) return hit;
  const body = pose === "jump" ? BODY_JUMP : pose === "throw" ? BODY_THROW : BODY_STAND;
  const headRows = BOSS_HEADS[head].map((row) => `....${row}....`);
  const rows = [...headRows, ...body].map((row) => row.padEnd(24, ".").slice(0, 24));
  frames.set(key, rows);
  return rows;
}

export function bossPortrait(head: string) {
  return BOSS_HEADS[head];
}
