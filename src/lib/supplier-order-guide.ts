// Reads supplier order guides / price exports into products with a case size
// and case price. Each supplier exports differently (Sysco splits Pack and Size,
// others write "4/5 LB" or "5#"), so columns are found by their header names,
// and a header-less paste falls back to: name, pack size, pack unit, price, item #.

export type GuideProduct = { sku: string; description: string; brand: string; category: string; packQuantity: number; packUnit: string; priceCents: number };

/** Minimal CSV/TSV row splitter that understands quoted cells. */
export function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === delimiter) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

const UNIT_WORDS: Record<string, string> = {
  "#": "lb", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", oz: "oz", ounce: "oz", ounces: "oz", "fl oz": "floz", floz: "floz",
  gal: "gal", gallon: "gal", gallons: "gal", ga: "gal", qt: "qt", quart: "qt", pt: "pt", pint: "pt", l: "l", lt: "l", liter: "l", ltr: "l", ml: "ml",
  kg: "kg", g: "g", gm: "g", gram: "g", ct: "each", count: "each", ea: "each", each: "each", pc: "each", pcs: "each", pk: "each", dz: "dozen", doz: "dozen", dozen: "dozen",
  cs: "each", case: "each", bag: "each", box: "each", can: "each", cn: "each", btl: "each", bottle: "each", roll: "each", sl: "each", slice: "each", loaf: "each",
};
export function normalizeUnit(raw: string) {
  const key = raw.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_WORDS[key] ?? UNIT_WORDS[key.replace(/s$/, "")] ?? key;
}

const fraction = (text: string) => {
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(text);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(text);
};

/**
 * "5 LB" → 5 lb, "5#" → 5 lb, "4/5 LB" → 20 lb, "12/16 OZ" → 192 oz, "1000 CT" → 1000 each,
 * "6/#10" → 6 each (cans), "2/1 GAL" → 2 gal, "1/2 GAL" → 0.5 gal.
 */
export function parseSize(text: string): { quantity: number; unit: string } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  const can = /^(\d+)\s*\/\s*#\s*\d+/.exec(t);
  if (can) return { quantity: Number(can[1]), unit: "each" };
  const packed = /^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(#|[a-z][a-z .]*)$/.exec(t);
  if (packed) {
    const [count, size, unit] = [Number(packed[1]), Number(packed[2]), normalizeUnit(packed[3])];
    // "1/2 GAL" is half a gallon; "4/5 LB" is four 5 lb packs.
    if (count === 1 && size >= 2 && size <= 4 && ["gal", "qt", "pt", "lb"].includes(unit)) return { quantity: 1 / size, unit };
    return { quantity: count * size, unit };
  }
  // Counts with no weight or volume (PFG paper goods and produce): "25/Cnt" → 25 each, "12/500" → 6000 each,
  // "1/18-24" → 21 each (a range counts at the middle). A decimal without a unit ("8/13.37") stays unread.
  const counted = /^(\d+)\s*\/\s*(cnt|ct|count|ea|each|pc|pcs)$/.exec(t);
  if (counted) return { quantity: Number(counted[1]), unit: "each" };
  if (/^\d+(?:-\d+)?(?:\s*\/\s*\d+(?:-\d+)?)+$/.test(t)) {
    const quantity = t.split("/").reduce((total, part) => {
      const [low, high] = part.trim().split("-").map(Number);
      return total * (high ? (low + high) / 2 : low);
    }, 1);
    if (quantity >= 2) return { quantity, unit: "each" };
  }
  // US Foods: nested packs, weight ranges and averages, e.g. "3/2/8.3 LBA" (3 × 2 × 8.3 lb), "2/9-10 LBA"
  // (2 × 9–10 lb, counted at the middle), "4/.5 GA", "4/13/1.25#A", "2/5 LBA+" (A = average weight).
  const nested = /^((?:(?:\d*\.)?\d+(?:-(?:\d*\.)?\d+)?\s*\/\s*)+(?:\d*\.)?\d+(?:-(?:\d*\.)?\d+)?)\s*(#a?|[a-z]+)\+?$/.exec(t);
  if (nested) {
    const raw = nested[2], unit = UNIT_WORDS[raw] ?? (raw.endsWith("a") ? UNIT_WORDS[raw.slice(0, -1)] : undefined);
    if (unit) {
      const quantity = nested[1].split("/").reduce((total, part) => {
        const [low, high] = part.trim().split("-").map(Number);
        return total * (high ? (low + high) / 2 : low);
      }, 1);
      if (Number.isFinite(quantity) && quantity > 0) return { quantity: Math.round(quantity * 1000) / 1000, unit };
    }
  }
  const single = /^(\d+(?:\.\d+)?|\d+\s+\d+\/\d+|\d+\/\d+)\s*(#|[a-z][a-z .]*)$/.exec(t);
  if (single) return { quantity: fraction(single[1]), unit: normalizeUnit(single[2]) };
  const bare = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (bare) return { quantity: Number(bare[1]), unit: "" };
  return null;
}

const money = (text: string) => {
  const n = Number(String(text || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

const HEADERS: Record<keyof GuideProduct | "pack" | "size" | "unit" | "price" | "unitPrice", RegExp> = {
  description: /^(item |product )?(description|desc|name)$|^product$|^item$/,
  sku: /^(item|product|sup|supc|mfr)\s*(#|no\.?|num(ber)?|code|id)$|^sku$|^supc$|^code$|^item number$/,
  brand: /brand/,
  category: /category|class|group/,
  pack: /^(pack|pk|case pack|pack qty|qty per case)$/,
  size: /^(size|pack size|item size|pack\/size|pack ?\/ ?size)$/,
  unit: /^(unit|uom|unit of measure|size unit|size uom)$/,
  price: /^(case price|price|cost|case cost|your price|net price|current price|sell price)$/,
  unitPrice: /^(unit price|each price|price per (unit|lb|each)|per lb)$/,
  packQuantity: /^$/,
  packUnit: /^$/,
  priceCents: /^$/,
};

/** Parses a pasted or exported order guide. Lines that can't be read are returned in `skipped`. */
export function parseGuide(text: string): { products: GuideProduct[]; skipped: string[]; fullExport: boolean } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { products: [], skipped: [], fullExport: false };
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const head = splitRow(lines[0], delimiter).map((h) => h.toLowerCase().replace(/\s+/g, " ").trim());
  const find = (key: keyof typeof HEADERS) => head.findIndex((h) => HEADERS[key].test(h));
  const col = { description: find("description"), sku: find("sku"), brand: find("brand"), category: find("category"), pack: find("pack"), size: find("size"), unit: find("unit"), price: find("price"), unitPrice: find("unitPrice") };
  const hasHeader = col.description >= 0 && (col.price >= 0 || col.unitPrice >= 0);
  const products: GuideProduct[] = [], skipped: string[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = splitRow(line, delimiter);
    let product: GuideProduct | null = null;
    if (hasHeader) {
      const get = (i: number) => (i >= 0 ? cells[i] ?? "" : "");
      const pack = get(col.pack), size = get(col.size), unitCell = get(col.unit);
      // Sysco style: Pack "4" + Size "5 LB" (or Size "5" + Unit "LB"); others: one "4/5 LB" cell.
      let quantity: number | null = null, unit = "";
      const sizeParsed = parseSize(size ? `${size}${unitCell && /^[\d./\s]+$/.test(size) ? ` ${unitCell}` : ""}` : "");
      const packParsed = parseSize(pack);
      if (sizeParsed && packParsed && packParsed.unit === "") {
        quantity = packParsed.quantity * sizeParsed.quantity;
        unit = sizeParsed.unit || normalizeUnit(unitCell);
      } else if (packParsed && packParsed.unit) {
        quantity = packParsed.quantity;
        unit = packParsed.unit;
      } else if (sizeParsed) {
        quantity = sizeParsed.quantity;
        unit = sizeParsed.unit || normalizeUnit(unitCell);
      } else if (packParsed) {
        quantity = packParsed.quantity;
        unit = normalizeUnit(unitCell) || "each";
      }
      let price = money(get(col.price));
      if (price == null && quantity) {
        const each = money(get(col.unitPrice));
        if (each != null) price = Math.round(each * quantity);
      }
      const description = get(col.description);
      if (description && quantity && quantity > 0 && unit && price)
        product = { sku: get(col.sku), description, brand: get(col.brand), category: get(col.category), packQuantity: Math.round(quantity * 1000) / 1000, packUnit: unit, priceCents: price };
    } else {
      // name, pack size, pack unit, case price[, item #]  — or name, "4/5 LB", case price[, item #]
      const [description = "", a = "", b = "", c = "", d = ""] = cells;
      const combined = parseSize(a);
      if (combined?.unit && money(b) != null) product = description ? { sku: c, description, brand: "", category: "", packQuantity: combined.quantity, packUnit: combined.unit, priceCents: money(b)! } : null;
      else {
        const quantity = Number(a), price = money(c);
        if (description && quantity > 0 && b && price) product = { sku: d, description, brand: "", category: "", packQuantity: quantity, packUnit: normalizeUnit(b), priceCents: price };
      }
    }
    if (product) products.push(product);
    else skipped.push(line.slice(0, 100));
  }
  // A file with headers is a supplier's whole export, not a short list of what we buy.
  return { products, skipped, fullExport: hasHeader };
}
