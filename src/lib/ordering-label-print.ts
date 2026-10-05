// Sticker labels for subs and pizzas: one label per sub/pizza, stuck on the
// wrapper or box so the counter and drivers can tell whose food is whose.
// Supports the three common label-printer languages.
import { sendRawToPrinter } from "@/lib/printer-network";

export type LabelLanguage = "zpl" | "tspl" | "escpos";
export const LABEL_LANGUAGES: Array<{ value: LabelLanguage; label: string; hint: string }> = [
  { value: "zpl", label: "ZPL", hint: "Zebra printers (ZD, GK, GX series)" },
  { value: "tspl", label: "TSPL", hint: "Rollo, Munbyn, Xprinter, TSC and most budget label printers" },
  { value: "escpos", label: "ESC/POS", hint: "Epson TM-L90 and other receipt-style label printers" },
];

export type ItemLabel = {
  /** Big identifier: order number plus a letter per item, e.g. "#1042-B". */
  code: string;
  /** "2/3" when the order has more than one labeled item. */
  count: string;
  customer: string;
  item: string;
  options: string[];
  note: string;
  /** Delivery address, or PICKUP / CURBSIDE / DINE IN. */
  destination: string;
  footer: string;
};

export function normalizeLabelConfig(config: Record<string, unknown>) {
  const language = ["zpl", "tspl", "escpos"].includes(String(config.labelLanguage)) ? (String(config.labelLanguage) as LabelLanguage) : "tspl";
  const clamp = (value: unknown, fallback: number, min: number, max: number) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
  };
  const categoryIds = Array.isArray(config.labelCategoryIds)
    ? [...new Set(config.labelCategoryIds.map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 100)
    : [];
  return {
    labelLanguage: language,
    labelWidthMm: clamp(config.labelWidthMm, 101, 25, 120),
    labelHeightMm: clamp(config.labelHeightMm, 51, 15, 200),
    labelCategoryIds: categoryIds,
  };
}

const ascii = (value: string) => value.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").trim();
function wrap(text: string, width: number, maxLines: number) {
  const words = ascii(text).split(/\s+/).filter(Boolean), lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word.slice(0, width);
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length)
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, width - 3))}...`;
  return lines;
}

type Line = { text: string; size: "xl" | "lg" | "md" | "sm"; bold?: boolean };
/** The label as lines, sized to fit `cols` characters of medium text. */
function layout(label: ItemLabel, cols: number): Line[] {
  const big = Math.max(8, Math.floor(cols / 2)), large = Math.max(10, Math.floor(cols * 0.7));
  const lines: Line[] = [{ text: `${label.code}${label.count ? `  ${label.count}` : ""}`.slice(0, big), size: "xl", bold: true }];
  for (const text of wrap(label.customer, large, 1)) lines.push({ text, size: "lg", bold: true });
  for (const text of wrap(label.item, large, 2)) lines.push({ text, size: "lg" });
  if (label.options.length) for (const text of wrap(label.options.join(", "), cols, 3)) lines.push({ text, size: "md" });
  if (label.note) for (const text of wrap(`NOTE: ${label.note}`, cols, 2)) lines.push({ text, size: "md", bold: true });
  for (const text of wrap(label.destination, cols, 2)) lines.push({ text, size: "md", bold: true });
  if (label.footer) lines.push({ text: ascii(label.footer).slice(0, cols + 6), size: "sm" });
  return lines;
}

const DOTS_PER_MM = 8; // 203 dpi, the standard for food label printers

function zpl(label: ItemLabel, widthMm: number, heightMm: number) {
  const width = widthMm * DOTS_PER_MM, height = heightMm * DOTS_PER_MM;
  const font = { xl: 56, lg: 34, md: 26, sm: 22 };
  const cols = Math.floor((width - 32) / (font.md * 0.55));
  const esc = (text: string) => text.replace(/[\^~\\]/g, " ");
  let y = 16;
  const parts = ["^XA", "^CI0", `^PW${width}`, `^LL${height}`, "^LH0,0"];
  for (const line of layout(label, cols)) {
    const size = font[line.size];
    if (y + size > height - 8) break;
    parts.push(`^FO16,${y}^A0N,${size},${line.bold ? Math.round(size * 1.05) : Math.round(size * 0.9)}^FD${esc(line.text)}^FS`);
    y += size + 6;
  }
  parts.push("^PQ1", "^XZ");
  return Buffer.from(parts.join("\n"), "ascii");
}

function tspl(label: ItemLabel, widthMm: number, heightMm: number) {
  const width = widthMm * DOTS_PER_MM, height = heightMm * DOTS_PER_MM;
  // Built-in font "3" is 16x24 dots; larger lines scale it up.
  const scale = { xl: 3, lg: 2, md: 1, sm: 1 } as const;
  const cols = Math.floor((width - 32) / 16);
  const esc = (text: string) => text.replace(/"/g, "'");
  let y = 16;
  const parts = [`SIZE ${widthMm} mm,${heightMm} mm`, "GAP 3 mm,0 mm", "DIRECTION 1", "REFERENCE 0,0", "CLS"];
  for (const line of layout(label, cols)) {
    const factor = scale[line.size], size = 24 * factor;
    if (y + size > height - 8) break;
    parts.push(`TEXT 16,${y},"3",0,${factor},${factor},"${esc(line.text)}"`);
    if (line.bold && factor === 1) parts.push(`TEXT 17,${y},"3",0,1,1,"${esc(line.text)}"`);
    y += size + 8;
  }
  parts.push("PRINT 1,1", "");
  return Buffer.from(parts.join("\r\n"), "ascii");
}

function escpos(label: ItemLabel, widthMm: number) {
  const cols = Math.max(24, Math.floor((widthMm - 8) / 1.5));
  const size = { xl: 0x22, lg: 0x11, md: 0x00, sm: 0x00 } as const;
  const chunks: Buffer[] = [Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x00])];
  for (const line of layout(label, cols)) {
    chunks.push(Buffer.from([0x1b, 0x45, line.bold ? 1 : 0, 0x1d, 0x21, size[line.size]]));
    chunks.push(Buffer.from(`${line.text}\n`, "ascii"));
  }
  chunks.push(Buffer.from([0x1b, 0x45, 0, 0x1d, 0x21, 0, 0x0a, 0x1d, 0x56, 0x42, 0x00]));
  return Buffer.concat(chunks);
}

export function renderLabel(config: Record<string, unknown>, label: ItemLabel) {
  const { labelLanguage, labelWidthMm, labelHeightMm } = normalizeLabelConfig(config);
  if (labelLanguage === "zpl") return zpl(label, labelWidthMm, labelHeightMm);
  if (labelLanguage === "escpos") return escpos(label, labelWidthMm);
  return tspl(label, labelWidthMm, labelHeightMm);
}

export async function sendLabel(config: Record<string, unknown>, label: ItemLabel) {
  await sendRawToPrinter(config, renderLabel(config, label));
}

export function sampleLabel(printerName: string): ItemLabel {
  return {
    code: "#TEST-A",
    count: "1/2",
    customer: "Test Customer",
    item: "Large Italian Sub",
    options: ["Hot peppers", "Extra cheese", "Toasted"],
    note: "No onions",
    destination: "DELIVERY: 828 Morris St, Ogdensburg",
    footer: `Label test · ${printerName}`,
  };
}
