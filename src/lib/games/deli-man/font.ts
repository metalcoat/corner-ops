/** 5x7 pixel font, 6px advance, 8px line height. Rows are 5-bit strings. */
const GLYPHS: Record<string, string> = {
  A: "01110 10001 10001 11111 10001 10001 10001",
  B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01110 10001 10000 10000 10000 10001 01110",
  D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111",
  F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111",
  H: "10001 10001 10001 11111 10001 10001 10001",
  I: "01110 00100 00100 00100 00100 00100 01110",
  J: "00111 00010 00010 00010 00010 10010 01100",
  K: "10001 10010 10100 11000 10100 10010 10001",
  L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 10001 11001 10101 10011 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101",
  R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100",
  W: "10001 10001 10001 10101 10101 10101 01010",
  X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100",
  Z: "11111 00001 00010 00100 01000 10000 11111",
  "0": "01110 10001 10011 10101 11001 10001 01110",
  "1": "00100 01100 00100 00100 00100 00100 01110",
  "2": "01110 10001 00001 00010 00100 01000 11111",
  "3": "11111 00010 00100 00010 00001 10001 01110",
  "4": "00010 00110 01010 10010 11111 00010 00010",
  "5": "11111 10000 11110 00001 00001 10001 01110",
  "6": "00110 01000 10000 11110 10001 10001 01110",
  "7": "11111 00001 00010 00100 01000 01000 01000",
  "8": "01110 10001 10001 01110 10001 10001 01110",
  "9": "01110 10001 10001 01111 00001 00010 01100",
  "!": "00100 00100 00100 00100 00100 00000 00100",
  "?": "01110 10001 00001 00010 00100 00000 00100",
  ".": "00000 00000 00000 00000 00000 01100 01100",
  ",": "00000 00000 00000 00000 01100 00100 01000",
  "'": "01100 00100 01000 00000 00000 00000 00000",
  '"': "01010 01010 00000 00000 00000 00000 00000",
  "-": "00000 00000 00000 11111 00000 00000 00000",
  ":": "00000 01100 01100 00000 01100 01100 00000",
  "/": "00001 00010 00010 00100 01000 01000 10000",
  "%": "11001 11010 00010 00100 01000 01011 10011",
  $: "00100 01111 10100 01110 00101 11110 00100",
  "+": "00000 00100 00100 11111 00100 00100 00000",
  "(": "00010 00100 01000 01000 01000 00100 00010",
  ")": "01000 00100 00010 00010 00010 00100 01000",
  "#": "01010 01010 11111 01010 11111 01010 01010",
  "&": "01100 10010 10100 01000 10101 10010 01101",
  "=": "00000 00000 11111 00000 11111 00000 00000",
  ">": "01000 00100 00010 00001 00010 00100 01000",
  "<": "00010 00100 01000 10000 01000 00100 00010",
  "*": "00000 00100 10101 01110 10101 00100 00000",
  "@": "01110 10001 10111 10101 10111 10000 01110",
};

const ORDER = Object.keys(GLYPHS);
const atlases = new Map<string, HTMLCanvasElement>();

export const CHAR_W = 6;
export const LINE_H = 8;

function atlas(color: string) {
  let canvas = atlases.get(color);
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.width = ORDER.length * CHAR_W;
  canvas.height = 7;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ORDER.forEach((ch, index) => {
    GLYPHS[ch].split(" ").forEach((row, y) => {
      for (let x = 0; x < 5; x++)
        if (row[x] === "1") ctx.fillRect(index * CHAR_W + x, y, 1, 1);
    });
  });
  atlases.set(color, canvas);
  return canvas;
}

export function textWidth(text: string, scale = 1) {
  return text.length * CHAR_W * scale - scale;
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color = "#fcfcfc",
  options: { scale?: number; align?: "left" | "center" | "right"; shadow?: string } = {},
) {
  const scale = options.scale ?? 1;
  const upper = text.toUpperCase();
  let left = Math.round(x);
  if (options.align === "center") left = Math.round(x - textWidth(upper, scale) / 2);
  if (options.align === "right") left = Math.round(x - textWidth(upper, scale));
  if (options.shadow)
    blit(ctx, upper, left + scale, Math.round(y) + scale, options.shadow, scale);
  blit(ctx, upper, left, Math.round(y), color, scale);
}

function blit(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale: number,
) {
  const source = atlas(color);
  for (let i = 0; i < text.length; i++) {
    const index = ORDER.indexOf(text[i]);
    if (index < 0) continue;
    ctx.drawImage(
      source,
      index * CHAR_W,
      0,
      5,
      7,
      x + i * CHAR_W * scale,
      y,
      5 * scale,
      7 * scale,
    );
  }
}

/** Word-wrap to a column budget. */
export function wrap(text: string, columns: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if ((line + " " + word).trim().length > columns) {
        lines.push(line.trim());
        line = word;
      } else line = `${line} ${word}`;
    }
    lines.push(line.trim());
  }
  return lines;
}
