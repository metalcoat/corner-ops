/* Enemy, projectile and pickup pixel art. Enemies face LEFT by default. */

export const HARDHAT_CLOSED = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  ".....KKKKKK.....",
  "...KKYYYYYYKK...",
  "..KYYyYYYYYYYK..",
  "..KYyYYYYYYYYK..",
  ".KYYYYYYYYYYYYK.",
  "KKKKKKKKKKKKKKKK",
  "KYYYYYYYYYYYYYYK",
  "KKKKKKKKKKKKKKKK",
  "..KK........KK..",
];

export const HARDHAT_OPEN = [
  "................",
  ".....KKKKKK.....",
  "...KKYYYYYYKK...",
  "..KYYyYYYYYYYK..",
  "..KYyYYYYYYYYK..",
  ".KYYYYYYYYYYYYK.",
  "KKKKKKKKKKKKKKKK",
  "KYYYYYYYYYYYYYYK",
  "KKKKKKKKKKKKKKKK",
  "..KSSSSSSSSSSK..",
  "..KKKKSKKKKSSK..",
  "..KWKWKKWKWKSK..",
  "..KKKKSKKKKSSK..",
  "KWWWKSKKKSSSK...",
  "KWgWKKKKKKKKK...",
  "KKKK.KK...KK....",
];

export const GOOSE_A = [
  "...........KK...",
  "..........KwwK..",
  "..KKK....KwwwK..",
  ".KKWKK..KwwwwK..",
  "KYKKKK.KwwwwwK..",
  ".KKKKK.KwwwwK...",
  "....KKKKKgggggK.",
  "....KWWgggggggKK",
  ".....KWWgggggggK",
  "......KKKKKKKKK.",
  "........KY..KY..",
  "................",
];

export const GOOSE_B = [
  "................",
  "..KKK...........",
  ".KKWKK..........",
  "KYKKKK..........",
  ".KKKKK..........",
  "....KKKKKKKKKKK.",
  "....KWWgggggggKK",
  ".....KWwwwwwwggK",
  "......KwwwwwwKK.",
  ".......KwwwwK...",
  "........KKKK....",
  "................",
];

export const TURRET_CLOSED = [
  "................",
  "....KKKKKKKKK...",
  "...KggggggggggK.",
  "..KgwwwwwwwwwgK.",
  "..KgwKKKKKKKwgK.",
  "..KgwKddddddKwgK",
  "..KgwKddddddKwgK",
  "..KgwKddddddKwgK",
  "..KgwKKKKKKKwgK.",
  "..KgwwwwwwwwwgK.",
  "..KgggggggggggK.",
  ".KKKKKKKKKKKKKKK",
  ".KgdgdgdgdgdgdgK",
  ".KdgdgdgdgdgdgdK",
  ".KKKKKKKKKKKKKKK",
  "................",
];

export const TURRET_OPEN = [
  "................",
  "....KKKKKKKKK...",
  "...KggggggggggK.",
  "..KgwwwwwwwwwgK.",
  "..KgwKKKKKKKwgK.",
  "KKKgwKOOOOOKwgK.",
  "KddKgKOYYYOKwgK.",
  "KKKgwKOOOOOKwgK.",
  "..KgwKKKKKKKwgK.",
  "..KgwwwwwwwwwgK.",
  "..KgggggggggggK.",
  ".KKKKKKKKKKKKKKK",
  ".KgdgdgdgdgdgdgK",
  ".KdgdgdgdgdgdgdK",
  ".KKKKKKKKKKKKKKK",
  "................",
];

export const HOPPER_SIT = [
  "................",
  "................",
  "................",
  "....KKKKKKKK....",
  "..KKddddddddKK..",
  ".KddWWddddWWddK.",
  ".KdWKWddddWKWdK.",
  "KddWWddddddWWddK",
  "KdddddKKKKdddddK",
  "KddddKRRRRKddddK",
  "KgddddKKKKddddgK",
  ".KgggggggggggggK",
  "KKKKKKKKKKKKKKKK",
  "................",
];

export const HOPPER_JUMP = [
  "....KKKKKKKK....",
  "..KKddddddddKK..",
  ".KddWWddddWWddK.",
  ".KdWKWddddWKWdK.",
  "KddWWddddddWWddK",
  "KdddddKKKKdddddK",
  "KddddKRRRRKddddK",
  "KgddddKKKKddddgK",
  ".KgggggggggggggK",
  "..KKKKKKKKKKKK..",
  "..KdK......KdK..",
  ".KddK......KddK.",
  "KKKK........KKKK",
  "................",
];

export const CART_A = [
  "..............KK",
  "KKKKKKKKKKKKKKRK",
  "KwKwKwKwKwKwKwKK",
  "KwwwwwwwwwwwwwK.",
  ".KwKwKwKwKwKwKK.",
  ".KwwwwwwwwwwwwK.",
  "..KwKwKwKwKwKK..",
  "..KwwwwwwwwwwK..",
  "...KKKKKKKKKKKK.",
  "...KgK......KgK.",
  "...KKKKKKKKKKKK.",
  "....KgK....KgK..",
  "...KKdKK..KKdKK.",
  "...KdddK..KdddK.",
  "....KKK....KKK..",
];

export const CART_B = [
  "..............KK",
  "KKKKKKKKKKKKKKRK",
  "KwKwKwKwKwKwKwKK",
  "KwwwwwwwwwwwwwK.",
  ".KwKwKwKwKwKwKK.",
  ".KwwwwwwwwwwwwK.",
  "..KwKwKwKwKwKK..",
  "..KwwwwwwwwwwK..",
  "...KKKKKKKKKKKK.",
  "...KgK......KgK.",
  "...KKKKKKKKKKKK.",
  "....KgK....KgK..",
  "...KKKKK..KKKKK.",
  "...KdgdK..KdgdK.",
  "....KKK....KKK..",
];

export const DEER_A = [
  "K.K.K...............",
  "KNKNK...............",
  ".KNNK.K.............",
  "..KNNKNK............",
  "..KNNNNK............",
  ".KWNKNNK............",
  "KKNNNNNK............",
  "KNNNNNNNKKKKKKKKKK..",
  ".KKKNNNNNNNNNNNNNNKK",
  "....KNNNNNNNNNNNNNNK",
  "....KyyNNNNNNNNNNNK.",
  "....KKyyNNNNNNNNNK..",
  "....KNKKKKKKKKKKNK..",
  "...KNK.........KNK..",
  "..KNK.........KNK...",
  "..KK..........KK....",
];

export const DEER_B = [
  "K.K.K...............",
  "KNKNK...............",
  ".KNNK.K.............",
  "..KNNKNK............",
  "..KNNNNK............",
  ".KWNKNNK............",
  "KKNNNNNK............",
  "KNNNNNNNKKKKKKKKKK..",
  ".KKKNNNNNNNNNNNNNNKK",
  "....KNNNNNNNNNNNNNNK",
  "....KyyNNNNNNNNNNNK.",
  "....KKyyNNNNNNNNNK..",
  ".....KNKKKKKKKNKK...",
  ".....KNK.....KNK....",
  "......KNK...KNK.....",
  "......KK....KK......",
];

/* Projectiles */
export const PELLET = [".KKK.", "KGGGK", "KGyGK", "KGGGK", ".KKK."];

export const SUB_MID = [
  ".KKKKKKKK.",
  "KTTTTTTTTK",
  "KGRGRGRGRK",
  "KttttttttK",
  ".KKKKKKKK.",
];

export const SUB_JUMBO = [
  "....KKKKKKKKKKKKKK....",
  "..KKyTTTTTTTTTTTTTKK..",
  ".KyTTTTyTTTTTyTTTTTTK.",
  "KTTTTTTTTTTTTTTTTTTTTK",
  "KGGRRGGRRGGRRGGRRGGRRK",
  "KyyWWyyWWyyWWyyWWyyWWK",
  "KttttttttttttttttttttK",
  ".KttttttttttttttttttK.",
  "..KKKKKKKKKKKKKKKKKK..",
];

export const ENEMY_SHOT = [".KK.", "KOYK", "KYOK", ".KK."];

/* Pickups */
export const PICKLE_CHIP = [".KKK.", "KGhGK", "KhGhK", "KGhGK", ".KKK."];
export const PICKLE_BIG = [
  "..KKK.",
  ".KGGGK",
  "KGhGGK",
  "KGGhGK",
  "KGhGGK",
  "KGGhGK",
  "KGhGGK",
  "KGGhGK",
  ".KGGK.",
  "..KK..",
];
export const MUSTARD_SMALL = ["KKKKKK", "KYYYYK", "KYRRYK", "KYYYYK", "KKKKKK"];
export const MUSTARD_BIG = [
  "..KKKK..",
  "..KRRK..",
  ".KKKKKK.",
  "KYYYYYYK",
  "KYyYYYYK",
  "KYyYRRYK",
  "KYyYRRYK",
  "KYYYYYYK",
  "KYYYYYYK",
  ".KKKKKK.",
];

export const EXPLOSION = [
  [
    "................",
    "................",
    "................",
    "................",
    "......KKKK......",
    ".....KWWWWK.....",
    "....KWYYYYWK....",
    "....KWYOOYWK....",
    "....KWYOOYWK....",
    "....KWYYYYWK....",
    ".....KWWWWK.....",
    "......KKKK......",
    "................",
  ],
  [
    "................",
    "....K.KKK..K....",
    "...KWKWWWKKWK...",
    "..KWWYYYYYWWWK..",
    "..KWYYOOOYYYWK..",
    ".KWYOOrrOOOYWK..",
    ".KWYOrrrrOOYWK..",
    ".KWYOOrrOOOYWK..",
    "..KWYYOOOYYWK...",
    "..KWWYYYYYWWK...",
    "...KWWKWWWKK....",
    "....KK.KKK......",
    "................",
  ],
  [
    "..K.....K....K..",
    ".KYK..K.....KYK.",
    "..K..KOK..K..K..",
    "......K..KOK....",
    "...K......K.....",
    "..KOK....K......",
    "...K....KYK..K..",
    ".........K..KOK.",
    "....K........K..",
    "...KYK...K......",
    "....K...KOK.....",
    "..........K.....",
    "................",
  ],
];

export const ORB_A = ["..KKKK..", ".KWWWWK.", "KWWYYWWK", "KWYYYYWK", "KWYYYYWK", "KWWYYWWK", ".KWWWWK.", "..KKKK.."];
export const ORB_B = ["........", "...KK...", "..KWWK..", ".KWYYWK.", ".KWYYWK.", "..KWWK..", "...KK...", "........"];
