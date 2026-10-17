// Native-resolution (SNES-style 256×224) pixel art for Delivery Boy. Sprites are
// authored as rows of palette characters and rasterised once into canvases.

export const PALETTE: Record<string, string> = {
  k: "#14141c", // outline
  w: "#f4f4ec", // white
  W: "#c8c8c0", // light grey
  m: "#e0e0e8", // metal
  s: "#8c94a0", // grey
  S: "#4c5460", // dark grey
  e: "#24242a", // tyre
  r: "#d8302c", // deli red
  R: "#8a1a18", // dark red
  y: "#f8d848", // mustard / light
  Y: "#c89820",
  o: "#f08830", // orange
  b: "#8c5428", // brown
  B: "#4a2c14", // dark brown
  t: "#d8b078", // bread / tan
  T: "#a8804c",
  g: "#5cac3c", // green
  G: "#2e6e2a",
  l: "#9cdc64",
  c: "#88d0f0", // glass
  C: "#3874b8", // blue
  n: "#1c3c78", // navy
  p: "#f4b898", // skin
  P: "#c07850",
};

export type Sprite = HTMLCanvasElement;

function raster(rows: readonly string[], swap: Record<string, string> = {}) {
  const width = Math.max(...rows.map((row) => row.length));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d")!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const key = swap[row[x]] ?? row[x];
      const color = PALETTE[key];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return canvas;
}

const CAR = [
  "....kkkkkkkk....",
  "...kwwwwwwwwk...",
  "..kwwrrrrrrwwk..",
  "eekwwwwwwwwwwkee",
  "eekwwwwwwwwwwkee",
  "..kkcccccccckk..",
  "..kcccccccccck..",
  "..kcccccccccck..",
  "..kkwwwwwwwwkk..",
  "..kwwwwwwwwwwk..",
  "..kwwwwwwwwwwk..",
  "..kwwwwwwwwwwk..",
  "..kwwwwwwwwwwk..",
  "..kwwwwwwwwwwk..",
  "..kwwwwwwwwwwk..",
  "..kwrrrrrrrrwk..",
  "..kwwwwwwwwwwk..",
  "..kkcccccccckk..",
  "eekwwwwwwwwwwkee",
  "eekwwwwwwwwwwkee",
  "..kwrwwwwwwrwk..",
  "..kwwwwwwwwwwk..",
  "...kkkkkkkkkk...",
];
// The Corner Deli Equinox wears a giant sub on its roof rack.
const ROOF_SUB = [
  "..kwwttttttwwk..",
  "..kwtyyyyyytwk..",
  "..kwtrrrrrrtwk..",
  "..kwtggggggtwk..",
  "..kwwttttttwwk..",
];
const PLAYER_CAR = [...CAR.slice(0, 9), ...ROOF_SUB, ...CAR.slice(14)];
const VAN = [
  ...CAR.slice(0, 9),
  ...Array(9).fill("..kwwwwwwwwwwk.."),
  ...CAR.slice(14),
];

const SPRITES = {
  player: PLAYER_CAR,
  dog: [
    "........bB..",
    "b......bbbbk",
    ".b.....bbbb.",
    "..bbbbbbbb..",
    "..bbbbbbbb..",
    "..bBbbbbBb..",
    "..b.b..b.b..",
    "..k.k..k.k..",
  ],
  cat: [
    ".......o.o",
    "o......ooo",
    ".o....ooko",
    "..ooooooo.",
    "..ooooooo.",
    "..o.o..o.o",
  ],
  squirrel: [
    ".ss.....",
    "sSss....",
    "ss.s..s.",
    "...ssss.",
    "..sssssk",
    "..sssss.",
    "...s.s..",
  ],
  raccoon: [
    "..........s.",
    "Ss.......sss",
    ".sS.....skks",
    "..Ssssssssss",
    "..ssssssss..",
    "..sSssssSs..",
    "..k.k..k.k..",
  ],
  goose: [
    "......ww..",
    ".....wwko.",
    "......w...",
    "......w...",
    "......w...",
    "..wwwww...",
    ".wwwwwww..",
    "wWwwwwww..",
    ".wWWwww...",
    "...o.o....",
    "..oo.oo...",
  ],
  deer: [
    "..........b.b.",
    "..........bbb.",
    "...........tt.",
    "..........tttk",
    "..........ttt.",
    ".t.......tt...",
    "..tttttttt....",
    "..tttttttt....",
    "..tTtttttT....",
    "..T.T...T.T...",
    "..T.T...T.T...",
    "..B.B...B.B...",
  ],
  cow: [
    "...............kk.",
    "..............wwww",
    "..............wkwp",
    "..wwwwwwwwwwwwwww.",
    ".wwkkwwwwwkkwwww..",
    "wwwkkwwwwwkkwwww..",
    ".wwwwwkkwwwwwwww..",
    "..wwwwkkwwwwwwww..",
    "..wwwwwwwwwppwww..",
    "..k.k......k.k....",
    "..k.k......k.k....",
  ],
  person: [
    "..BBB...",
    "..ppp...",
    "..ppp...",
    ".CCCCC..",
    "pCCCCCp.",
    "p.CCC.p.",
    "..CCC...",
    "..nnn...",
    "..n.n...",
    ".n...n..",
    ".n...n..",
    "kk...kk.",
  ],
  mower: [
    "..k.....k...",
    "...k...k....",
    "....kkk.....",
    "....k.k.....",
    ".rrrrrrrrr..",
    "rRrrrrrrrRr.",
    "rrrSSSSSrrr.",
    "rrrSkkkSrrr.",
    "rRrrrrrrrRr.",
    "ek.......ke.",
    "ee.......ee.",
  ],
  pothole: [
    "....SSSSSSS.....",
    "..SSkkkkkkkSS...",
    ".SkkkkkkkkkkkS..",
    "SkkkkkkkkkkkkkS.",
    ".SkkkkkkkkkkkS..",
    "..SSkkkkkkkSS...",
    "....SSSSSSS.....",
  ],
  boost: [
    "..yy...",
    "..lgl..",
    ".lgggl.",
    ".ggGgg.",
    ".gGggg.",
    ".gggGg.",
    ".ggGgg.",
    ".gGggg.",
    ".gggGg.",
    ".lgggl.",
    "..lgl..",
    "...g...",
  ],
  slow: [
    ".cccccccccc.",
    "cwcwccwccwcc",
    "cCCCCCCCCCCc",
    "cwwwwwwwwwwc",
    "cccccccccccc",
    ".cccccccccc.",
  ],
  restock: [
    "..k....k..",
    "...k..k...",
    ".tttttttt.",
    ".tTTTTTTt.",
    ".tttttttt.",
    ".trrrrrrt.",
    ".trwrrwrt.",
    ".trrrrrrt.",
    ".tttttttt.",
    ".tttttttt.",
    ".TTTTTTTT.",
  ],
  sub: [".tttttt.", "tyrgyrgt", "tttttttt", ".TTTTTT."],
  bag: [".k..k.", "tttttt", "trrrrt", "tttttt", "TTTTTT"],
  trash: [
    ".SSSSSS.",
    "SmmmmmmS",
    ".SSSSSS.",
    ".smmmms.",
    ".smsmms.",
    ".smsmms.",
    ".smsmms.",
    ".smmmms.",
    ".ssssss.",
  ],
  cart: [
    "k...........",
    ".k..........",
    "..kmmmmmmmmk",
    "..kmkmkmkmmk",
    "..kmmmmmmmmk",
    "...kmkmkmmk.",
    "....kkkkkk..",
    "....k....k..",
    "...ee....ee.",
  ],
  tent: [
    "......kk........",
    ".....kook.......",
    "....kooook......",
    "...kooBoook.....",
    "..kooBBBoook....",
    ".kooBBBBBoook...",
    "koooBBBBBooook..",
    "kkkkkkkkkkkkkk..",
  ],
  heart: [
    ".rr.rr.",
    "rrrrrrr",
    "rrrrrrr",
    ".rrrrr.",
    "..rrr..",
    "...r...",
  ],
  tree: [
    "....GGGGG....",
    "..GGgggggGG..",
    ".GgglggggggG.",
    "GggggggglgggG",
    "GgglgggggggGG",
    "GggggggggggG.",
    ".GGgggglggGG.",
    "..GGGggggGG..",
    "....GGGGG....",
    ".....BbB.....",
    ".....BbB.....",
  ],
  bush: [
    "..GGGG..",
    ".GgglgG.",
    "GggggggG",
    "GglgggGG",
    ".GGGGGG.",
  ],
  flowers: ["r.y.r", ".g.g.", "y.r.y"],
} as const;

export type SpriteName =
  | keyof typeof SPRITES
  | "car"
  | "van"
  | "abandoned"
  | "heartEmpty";

let cache: Record<SpriteName, Sprite> | null = null;

export function sprites() {
  if (cache) return cache;
  const built = Object.fromEntries(
    Object.entries(SPRITES).map(([name, rows]) => [name, raster(rows)]),
  ) as Record<SpriteName, Sprite>;
  // Oncoming traffic is the same body, flipped, in other colours.
  built.car = raster([...CAR].reverse(), { w: "C", r: "n" });
  built.van = raster([...VAN].reverse(), { w: "t", r: "B", c: "S" });
  built.abandoned = raster(CAR, { w: "b", r: "B", c: "S", e: "B" });
  built.heartEmpty = raster(SPRITES.heart, { r: "S" });
  cache = built;
  return built;
}

// ---- 5×7 bitmap font ----
const GLYPHS: Record<string, string> = {
  A: ".###.#...##...#######...##...##...#",
  B: "####.#...##...#####.#...##...#####.",
  C: ".###.#...##....#....#....#...#.###.",
  D: "####.#...##...##...##...##...#####.",
  E: "######....#....####.#....#....#####",
  F: "######....#....####.#....#....#....",
  G: ".###.#...##....#.####...##...#.####",
  H: "#...##...##...#######...##...##...#",
  I: ".###...#....#....#....#....#...###.",
  J: "..###...#....#....#....#.#..#..##..",
  K: "#...##..#.#.#..##...#.#..#..#.#...#",
  L: "#....#....#....#....#....#....#####",
  M: "#...###.###.#.##.#.##...##...##...#",
  N: "#...##...###..##.#.##..###...##...#",
  O: ".###.#...##...##...##...##...#.###.",
  P: "####.#...##...#####.#....#....#....",
  Q: ".###.#...##...##...##.#.##..#..##.#",
  R: "####.#...##...#####.#.#..#..#.#...#",
  S: ".#####....#.....###.....#....#####.",
  T: "#####..#....#....#....#....#....#..",
  U: "#...##...##...##...##...##...#.###.",
  V: "#...##...##...##...##...#.#.#...#..",
  W: "#...##...##...##.#.##.#.##.#.#.#.#.",
  X: "#...##...#.#.#...#...#.#.#...##...#",
  Y: "#...##...#.#.#...#....#....#....#..",
  Z: "#####....#...#...#...#...#....#####",
  "0": ".###.#...##..###.#.###..##...#.###.",
  "1": "..#...##....#....#....#....#...###.",
  "2": ".###.#...#....#...#...#...#...#####",
  "3": "#####...#...#.....#.....##...#.###.",
  "4": "...#...##..#.#.#..#.#####...#....#.",
  "5": "######....####.....#....##...#.###.",
  "6": "..##..#...#....####.#...##...#.###.",
  "7": "#####....#...#...#...#....#....#...",
  "8": ".###.#...##...#.###.#...##...#.###.",
  "9": ".###.#...##...#.####....#...#..##..",
  " ": "...................................",
  ".": "..........................##...##..",
  ",": ".....................##....#...#...",
  "!": "..#....#....#....#....#.........#..",
  "?": ".###.#...#....#...#...#.........#..",
  "'": "..#....#...#.......................",
  "-": "...............#####...............",
  "+": ".......#....#..#####..#....#.......",
  "/": "....#....#...#...#...#...#....#....",
  ":": "......##...##.........##...##......",
  "#": ".#.#..#.#.#####.#.#.#####.#.#..#.#.",
  "(": "...#...#...#....#....#.....#.....#.",
  ")": ".#.....#.....#....#....#...#...#...",
  "&": ".##..#..#.#.#...#...#.#.##..#..##.#",
  "×": ".....#...#.#.#...#...#.#.#...#.....",
  "✓": ".........#...#.#.#...#.............",
  "◀": "...#...##..###.####..###...##....#.",
  "▶": ".#....##...###..####.###..##...#...",
  "·": "...............#...................",
  "$": "..#...#####.#...###...#.#####...#..",
  "%": "##..###..#...#...#...#...#..###..##",
  '"': ".#.#..#.#..........................",
  "<": "...#...#...#...#.....#.....#.....#.",
  ">": ".#.....#.....#.....#...#...#...#...",
};
const glyphCache = new Map<string, HTMLCanvasElement>();

function normalise(text: string) {
  return text
    .toUpperCase()
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/✗/g, "×")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

export function textWidth(text: string, scale = 1) {
  return normalise(text).length * 6 * scale - scale;
}

/** Renders text in the 5×7 pixel font, cached per string/colour/scale. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  options: { scale?: number; align?: "left" | "center" | "right"; shadow?: string } = {},
) {
  const scale = options.scale ?? 1;
  const clean = normalise(text);
  const key = `${clean}|${color}|${scale}|${options.shadow ?? ""}`;
  let canvas = glyphCache.get(key);
  if (!canvas) {
    if (glyphCache.size > 400) glyphCache.clear();
    canvas = document.createElement("canvas");
    const shadow = options.shadow ? scale : 0;
    canvas.width = Math.max(1, textWidth(clean, scale) + shadow);
    canvas.height = 7 * scale + shadow;
    const g = canvas.getContext("2d")!;
    const paint = (fill: string, offset: number) => {
      g.fillStyle = fill;
      [...clean].forEach((char, index) => {
        const glyph = GLYPHS[char] ?? GLYPHS["?"];
        for (let i = 0; i < 35; i++)
          if (glyph[i] === "#")
            g.fillRect(
              (index * 6 + (i % 5)) * scale + offset,
              Math.floor(i / 5) * scale + offset,
              scale,
              scale,
            );
      });
    };
    if (options.shadow) paint(options.shadow, scale);
    paint(color, 0);
    glyphCache.set(key, canvas);
  }
  const left =
    options.align === "center"
      ? x - Math.floor(canvas.width / 2)
      : options.align === "right"
        ? x - canvas.width
        : x;
  ctx.drawImage(canvas, Math.round(left), Math.round(y));
  return canvas.width;
}

/** Greedy word wrap for the pixel font. */
export function wrapText(text: string, maxWidth: number, scale = 1) {
  const words = normalise(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, scale) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
