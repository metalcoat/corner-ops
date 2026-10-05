// Finds products and prices in the data a supplier's website loads (the JSON its
// order-guide page fetches), whatever the site's layout, and writes them as the
// order-guide CSV the app already reads. Used by the website price job in
// deploy/supplier-scraper, which runs it with Node's TypeScript support, so this
// file must stay self-contained: no imports, only erasable type syntax.

export type WebProduct = {
  sku: string;
  description: string;
  brand: string;
  pack: string;
  size: string;
  unit: string;
  casePrice: number | null;
  unitPrice: number | null;
};

type Flat = Array<[string[], string | number | boolean]>;

/** Leaf values with their key path, up to a few levels deep (prices are often nested). */
function flatten(value: unknown, path: string[] = [], out: Flat = [], depth = 0): Flat {
  if (depth > 4 || value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push([path, value]);
    return out;
  }
  if (Array.isArray(value)) {
    // A short list of prices/packs inside a product (e.g. case and each) — keep the first few.
    value.slice(0, 3).forEach((entry, i) => flatten(entry, [...path, String(i)], out, depth + 1));
    return out;
  }
  if (typeof value === "object") for (const [key, entry] of Object.entries(value as Record<string, unknown>)) flatten(entry, [...path, key], out, depth + 1);
  return out;
}

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const DESCRIPTION = /^(description|desc|name|productname|productdescription|itemdescription|itemname|title|longdescription|shortdescription|displayname|materialdescription)$/;
const SKU = /^(sku|supc|itemnumber|itemno|itemnum|productnumber|productno|productnum|productid|materialnumber|materialid|itemid|itemcode|productcode|code|id)$/;
const BRAND = /^(brand|brandname|brandtitle|manufacturer|mfrname)$/;
const PACK = /^(pack|packsize|packqty|packquantity|casepack|unitspercase|packcount|innerpack)$/;
const SIZE = /^(size|itemsize|sizedescription|packsizedescription|packandsize|packsizetext|packsizedisplay|unitsize)$/;
const UNIT = /^(uom|unit|unitofmeasure|sizeuom|sizeunit|uomdescription|sellinguom)$/;
const PRICEISH = /(price|cost|amount|value)$/;
const EXCLUDE_PRICE = /(list|msrp|retail|was|previous|old|compare|savings|discount|deposit|tax|fee|total|extended|min|max)/;
const EACH = /(each|unit|split|perpound|perlb|lb|piece|ea)/;

function money(value: string | number | boolean): number | null {
  if (typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : null;
}

/** One product from a flattened object, or null if it doesn't look like one. */
function asProduct(flat: Flat): WebProduct | null {
  const find = (re: RegExp, accept: (v: string | number | boolean) => boolean = () => true) => {
    for (const [path, v] of flat) if (re.test(norm(path[path.length - 1] ?? "")) && accept(v)) return v;
    return undefined;
  };
  const text = (v: string | number | boolean | undefined) => (v === undefined ? "" : String(v).trim());
  // A real description beats a "name", and a brand's or category's name is never the product.
  const describes = (strong: boolean) =>
    flat.find(([p, v]) => {
      const last = norm(p[p.length - 1] ?? "");
      if (typeof v !== "string" || v.trim().length < 3 || !/[a-z]/i.test(v) || !DESCRIPTION.test(last)) return false;
      if (p.slice(0, -1).some((segment) => /brand|manufacturer|category|vendor|supplier|class|group|list/.test(norm(segment)))) return false;
      return strong ? /desc/.test(last) : true;
    });
  const description = text((describes(true) ?? describes(false))?.[1]);
  if (!description) return null;
  let sku = text(find(SKU, (v) => /^[A-Za-z0-9-]{3,20}$/.test(String(v))));
  // Prefer a real item number over a generic "id".
  const specific = flat.find(([p, v]) => /^(supc|sku|itemnumber|itemno|productnumber|materialnumber|itemcode|productcode)$/.test(norm(p[p.length - 1] ?? "")) && /^[A-Za-z0-9-]{3,20}$/.test(String(v)));
  if (specific) sku = String(specific[1]);
  let casePrice: number | null = null, unitPrice: number | null = null;
  for (const [path, v] of flat) {
    const joined = norm(path.join("."));
    const last = norm(path[path.length - 1] ?? "");
    if (!PRICEISH.test(last) && !/price/.test(joined)) continue;
    if (!/price|cost/.test(joined) || EXCLUDE_PRICE.test(joined.replace(/price$/, ""))) continue;
    const amount = money(v);
    if (amount == null) continue;
    if (/case|cs/.test(joined)) casePrice ??= amount;
    else if (EACH.test(joined.replace(/price|cost|amount|value/g, ""))) unitPrice ??= amount;
    else casePrice ??= amount;
  }
  if (casePrice == null && unitPrice == null) return null;
  const pack = text(find(PACK, (v) => /^\s*\d+(\.\d+)?\s*$/.test(String(v)) || /\d+\s*\/\s*\d/.test(String(v))));
  const size = text(find(SIZE, (v) => /\d/.test(String(v))));
  const unit = text(find(UNIT, (v) => typeof v === "string" && v.length <= 12));
  if (!pack && !size) return null;
  // Brand is either a field ("brand": "X") or an object ("brand": { "name": "X" }).
  const brandEntry = flat.find(([p, v]) => typeof v === "string" && p.some((segment) => BRAND.test(norm(segment))));
  return { sku, description, brand: brandEntry ? String(brandEntry[1]).trim() : "", pack, size, unit, casePrice, unitPrice };
}

/** Every product found anywhere in a JSON document (lists of 2+ product-like objects). */
export function extractProducts(json: unknown): WebProduct[] {
  const found: WebProduct[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const objects = value.filter((v) => v && typeof v === "object" && !Array.isArray(v));
      if (objects.length >= 2) {
        const products = objects.map((o) => asProduct(flatten(o))).filter((p): p is WebProduct => p !== null);
        // Most of the list has to be products, or it's something else that happens to have names.
        if (products.length >= Math.max(2, objects.length * 0.5)) {
          found.push(...products);
          return;
        }
      }
      for (const v of value) visit(v, depth + 1);
      return;
    }
    for (const v of Object.values(value as Record<string, unknown>)) visit(v, depth + 1);
  };
  visit(json, 0);
  return found;
}

/** One row per product (by item # or name), keeping the entry with a case price. */
export function dedupeProducts(products: WebProduct[]): WebProduct[] {
  const byKey = new Map<string, WebProduct>();
  for (const p of products) {
    const key = (p.sku || p.description).toLowerCase();
    const current = byKey.get(key);
    if (!current || (current.casePrice == null && p.casePrice != null)) byKey.set(key, p);
  }
  return [...byKey.values()];
}

const cell = (value: string | number | null) => {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The order-guide CSV the app's importer reads (headers it recognizes). */
export function productsToCsv(products: WebProduct[]): string {
  const rows = [["Item #", "Pack", "Size", "Unit", "Brand", "Description", "Case Price", "Unit Price"]];
  for (const p of products)
    rows.push([p.sku, p.pack, p.size, p.unit, p.brand, p.description, p.casePrice == null ? "" : p.casePrice.toFixed(2), p.unitPrice == null ? "" : p.unitPrice.toFixed(2)]);
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

/**
 * The one-time sign-in code in a supplier's email or text ("Your verification
 * code is 482913"). Numbers near the words code/verification/passcode win;
 * years, prices, phone numbers and ZIP codes lose.
 */
export function extractSignInCode(text: string): string | null {
  const clean = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const candidates: Array<{ code: string; score: number }> = [];
  for (const match of clean.matchAll(/(?<![\d$.,\-/:#(])(\d{4,8})(?![\d,\-/:%)]|\.\d)/g)) {
    const code = match[1], at = match.index ?? 0;
    const before = clean.slice(Math.max(0, at - 80), at).toLowerCase(), after = clean.slice(at + code.length, at + code.length + 30).toLowerCase();
    if (/^(19|20)\d\d$/.test(code) && !/code/.test(before.slice(-25))) continue; // a year
    if (/(zip|ny|suite|ste|po box|street|st\.|ave)\s*$/.test(before) || /^\s*(st|ave|rd|street|road)\b/.test(after)) continue; // an address
    let score = code.length === 6 ? 3 : code.length === 8 || code.length === 4 ? 1 : 0;
    if (/(code|passcode|verification|one[- ]time|otp|pin)\W{0,20}$/.test(before)) score += 10;
    else if (/(code|passcode|verification|one[- ]time|otp)/.test(before)) score += 5;
    if (/^\s*(is|expires|to sign|to verify|to log)/.test(after)) score += 2;
    candidates.push({ code, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] && candidates[0].score >= 5 ? candidates[0].code : null;
}
