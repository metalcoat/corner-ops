/**
 * Corner Deli TV menu board: what each of the three menu TVs shows, the promo screens and
 * the holiday seasons. Items are named "Category|Item" (the POS category's own name and the
 * item's POS name), so prices and sold-out marks always come from the POS. An item that is
 * missing from the POS is left off the TV and reported in the board's `missing` list.
 *
 * Edit freely: change the screens, promos, ticker and season dates here.
 */

export type PriceIndexItem = {
  basePriceCents: number;
  available: boolean;
  /** Active sizes in POS order. An item with exactly one size is charged that size's price. */
  variants: { name: string; priceCents: number; available: boolean }[];
};
export type PriceIndex = Map<string, PriceIndexItem>;

/** A price grid: each cell is the item and size named by its row and column together. */
type GridAxis = { label: string; item?: string; variant?: string };
type GridSpec = { kind: "grid"; title: string; note?: string; columns: GridAxis[]; rows: GridAxis[] };
type ListSpec = { kind: "list"; title: string; note?: string; rows: { label: string; item?: string; items?: string[]; variants?: string[]; note?: string }[] };
type FeatureSpec = { kind: "feature"; title: string; text: string; item: string };
type BlockSpec = GridSpec | ListSpec | FeatureSpec;
type MenuScreenSpec = { key: string; title: [string, string]; tag: [string, string]; layout: "two" | "three"; columns: BlockSpec[][] };

export type PromoSpec = {
  key: string;
  kicker: string;
  name: string;
  text: string;
  /** Badge price from the POS: the item, and its size when it has several. */
  price?: { label: string; item: string; variant?: string };
  /** Badge text instead of a price, such as a date. */
  badge?: { label: string; text: string };
  /** Small line under a photo, built from POS prices: [label, item, size]. */
  extras?: [string, string, string?][];
  photo?: string;
  qr?: boolean;
};

export type SeasonKey = "everyday" | "halloween" | "thanksgiving" | "christmas";
type SeasonSpec = {
  key: SeasonKey;
  /** Month-day ranges, inclusive, in store time. */
  from?: string;
  to?: string;
  ribbon: string;
  /** Promo swaps for this season: everyday promo key → season promo key. */
  swap: Record<string, string>;
  ticker: [string, string][];
};

const SUBS = "Subs/Wraps";
const SUB_COLUMNS = [{ label: "½ Sub", variant: "1/2 Sub" }, { label: "Full", variant: "Full Sub" }, { label: "Wrap", variant: "Wraps" }];
const sizes = (names: string[], label = (n: string) => n) => names.map((name) => ({ label: label(name), variant: name }));
const sub = (label: string, name = label) => ({ label, item: `${SUBS}|${name}` });

export const MENU_SCREENS: MenuScreenSpec[] = [
  { key: "pizza", title: ["Pizza ", "& Wings"], tag: ['12" to sheet pizza', "Wings tossed in your sauce"], layout: "two", columns: [
    [ { kind: "grid", title: "Pizza", note: "add toppings at the counter",
        columns: [{ label: "Cheese", item: "Pizza and Wings|Pizza" }, { label: "Breakfast", item: "Pizza and Wings|Breakfast Pizza" }],
        rows: sizes(['Small 12"', 'Regular 14"', 'Jumbo Thin 16"', 'Jumbo Thick 16"', "Sheet Pizza"]) },
      { kind: "feature", title: "Cheesy Breadsticks", text: "Nine pieces baked with garlic sauce", item: "Pizza and Wings|Cheesy Breadsticks" } ],
    [ { kind: "grid", title: "Wings", note: "double fried",
        columns: [{ label: "Bone-in", item: "Pizza and Wings|Wings" }, { label: "Boneless", item: "Pizza and Wings|Boneless Wings" }],
        rows: sizes(["10", "12", "15", "20", "24", "30", "50"].map((n) => `${n} Wings`), (n) => n.replace("Wings", "wings")) } ] ] },
  { key: "subs", title: ["Subs ", "& Wraps"], tag: ["Half, full or wrap", "Built your way"], layout: "two", columns: [
    [ { kind: "grid", title: "Deli Subs", columns: SUB_COLUMNS, rows: [sub("Turkey"), sub("Ham"), sub("Roast Beef"), sub("Tuna"), sub("Mixed Italian"), sub("Turkey Club"), sub("BLT"), sub("Veggie")] } ],
    [ { kind: "grid", title: "Hot Subs", columns: SUB_COLUMNS, rows: [sub("Steak"), sub("Chicken Bacon Ranch"), sub("Buffalo Chicken"), sub("Chicken Fajita"), sub("Turkey Big Boss"), sub("Meatball Sub"), sub("Chicken Parmesan", "Chicken Parmesan Sub"), sub("Hot Sausage")] } ] ] },
  { key: "burgers", title: ["Burgers ", "& Baskets"], tag: ["Homemade buns", "Add fries from $3.00"], layout: "three", columns: [
    [ { kind: "list", title: "Burgers", rows: [
        { label: "Hamburger", item: "Burgers|Hamburger", note: "¼ lb" }, { label: "Cheeseburger", item: "Burgers|Cheeseburger (1/4lbs)", note: "¼ lb" },
        { label: "Double Cheeseburger", item: "Burgers|Double Cheeseburger (1/2lbs)", note: "½ lb" }, { label: "Triple Cheeseburger", item: "Burgers|Triple Cheeseburger (3/4lbs)", note: "¾ lb" },
        { label: "Wild West Burger", item: "Burgers|Wild West Burger" }, { label: "Bus Driver Burger", item: "Burgers|Bus Driver Burger (1/2lbs)" },
        { label: "Cactus Burger", item: "Burgers|Cactus Burger" }, { label: "Ogdensburger", item: "Burgers|Ogdensburger" }, { label: "Cordon Blue Burger", item: "Burgers|Cordon Blue Burger" } ] } ],
    [ { kind: "list", title: "Tenders", rows: [
        { label: "2 Chicken Tenders", item: "Tenders/ Finger Foods|2 Chicken Tenders" }, { label: "4 Chicken Tenders", item: "Tenders/ Finger Foods|4 Chicken Tenders" },
        { label: "Tender Dinner", item: "Tenders/ Finger Foods|Chicken Tender Dinner" }, { label: "Nuggets (10)", item: "Tenders/ Finger Foods|Chicken Nuggets (10 piece)" },
        { label: "The Gobbler", item: "Tenders/ Finger Foods|The Gobbler" } ] },
      { kind: "list", title: "Kids", note: "with small fry", rows: [
        { label: "Chicken Nuggets", item: "Kids Menu|Chicken Nuggets w/ SM Fry" }, { label: "Grilled Cheese", item: "Kids Menu|Grilled Cheese w/ SM Fry" }, { label: "Hot Dog", item: "Kids Menu|Hot Dog w/ SM Fry" } ] } ],
    [ { kind: "list", title: "Sides", note: "small / large", rows: [
        { label: "French Fries", items: ["Side Dishes|Small French Fries", "Side Dishes|Large French Fries"] },
        { label: "Curly Fries", items: ["Side Dishes|Small Curly Fries", "Side Dishes|Large Curly Fries"] },
        { label: "Tater Tots", items: ["Side Dishes|Small Tater Tots", "Side Dishes|Large Tater Tots"] },
        { label: "Waffle Fries", items: ["Side Dishes|Small Waffle Fries", "Side Dishes|Large Waffle Fries"] },
        { label: "Onion Rings", item: "Side Dishes|Onion Rings" } ] },
      { kind: "list", title: "Sandwiches", rows: [
        { label: "Grilled Cheese", item: "Sandwiches|Grilled Cheese Sandwich" }, { label: "BLT", item: "Sandwiches|BLT Sandwich" }, { label: "Clubhouse", item: "Sandwiches|Clubhouse Sandwich" } ] } ] ] },
  { key: "dinners", title: ["Dinners ", "& Salads"], tag: ["Fish fry with 1 or 2 sides", "Italian, Mexican and more"], layout: "three", columns: [
    [ { kind: "list", title: "Hot Meals", rows: [
        { label: "Hot Turkey", item: "Hot Meat Meals|Hot Turkey" }, { label: "Hot Roast Beef", item: "Hot Meat Meals|Hot Roast Beef" }, { label: "Hot Hamburger", item: "Hot Meat Meals|Hot Hamburger" },
        { label: "Avalanche", item: "Hot Meat Meals|Avalanche" }, { label: "Mudslide", item: "Hot Meat Meals|Mudslide" }, { label: "Hamburger Steak", item: "Hot Meat Meals|Hamburger Steak (Meal)" } ] },
      { kind: "list", title: "Fish", rows: [
        { label: "Fish Fry, 1 side", item: "Fish|Fish Fry Dinner - 1 Side" }, { label: "Fish Fry, 2 sides", item: "Fish|Fish Fry Dinner - 2 Sides" } ] } ],
    [ { kind: "list", title: "Italian", rows: [
        { label: "Spaghetti", item: "Italian Dinners|Spaghetti" }, { label: "Chicken Parmesan", item: "Italian Dinners|Chicken Parmesan" }, { label: "Spaghetti Supreme", item: "Italian Dinners|Spaghetti Supreme" } ] },
      { kind: "list", title: "Mexican", rows: [
        { label: "Cheese Quesadilla", item: "Mexican|Cheese Quesadilla" }, { label: "Chicken Quesadilla", item: "Mexican|Chicken Quesadilla" }, { label: "Nacho Supreme", item: "Mexican|Nacho Supreme" } ] } ],
    [ { kind: "list", title: "Salads", rows: [
        { label: "Small Tossed", item: "Salads|SM Tossed Sal" }, { label: "Large Tossed", item: "Salads|LG Tossed Sal" }, { label: "Grilled Chicken", item: "Salads|Grilled Chicken Sal" },
        { label: "Buffalo Chicken", item: "Salads|Buffalo Fried Chicken Sal" }, { label: "Julienne", item: "Salads|Julienne Sal" }, { label: "Cold Plate", item: "Salads|Cold Plate" } ] } ] ] },
  { key: "apps", title: ["Starters ", "& Sweets"], tag: ["Made for sharing", "Deli salads by the tub"], layout: "three", columns: [
    [ { kind: "list", title: "Starters", rows: [
        { label: "Mozzarella Sticks", item: "Appetizers|Mozzarella Sticks" }, { label: "Pizza Logs", item: "Appetizers|Pizza Logs" }, { label: "Buffalo Chips", item: "Appetizers|Buffalo Chips" },
        { label: "Cheese Curds", item: "Appetizers|Deep Fried Cheese Curd" }, { label: "Mac & Cheese Bites", item: "Appetizers|Mac & Cheese Bites (6)" }, { label: "Popcorn Chicken", item: "Appetizers|Pop Corn Chicken" },
        { label: "Breaded Mushrooms", item: "Appetizers|Breaded Mushrooms" }, { label: "Beefy Nachos", item: "Appetizers|Beefy Nachos" }, { label: "Potato Skins", item: "Appetizers|Potato Skins" } ] } ],
    [ { kind: "list", title: "Samplers", rows: [
        { label: "Variety for Two", item: "Appetizers|Variety for TWO" }, { label: "Variety for Four", item: "Appetizers|Variety for Four" }, { label: "Fathead Special", item: "Appetizers|Fathead Special" } ] },
      { kind: "list", title: "Sweets", rows: [
        { label: "Chocolate Overload", item: "Desserts|Chocolate Overload" }, { label: "Rainbow Cake", item: "Desserts|Rainbow Cake" },
        { label: "Mile High Cake", item: "Desserts|Milky Caramel Mile High Cake" }, { label: "Apple Pie Logs (6)", item: "Desserts|6 Piece Apple Pie Logs" } ] } ],
    [ { kind: "list", title: "Deli Salads", note: "8 / 16 / 32 oz", rows: ["Potato Salad", "Mac Salad", "Pasta Salad", "Cole Slaw", "AntiPasto"].map((name) => ({
        label: name === "AntiPasto" ? "Antipasto" : name, item: `Deli Salads|${name}`, variants: ["Small 8oz", "Medium 16oz", "Large 32oz"] })) } ] ] },
];

export const PROMOS: PromoSpec[] = [
  { key: "breakfast", kicker: "Our signature pie", name: "Breakfast Pizza", text: "American-cheese garlic sauce, eggs, melted cheese and your choice of toppings.", price: { label: "From", item: "Pizza and Wings|Breakfast Pizza", variant: 'Small 12"' } },
  { key: "tbb", kicker: "Fresh off the toaster", name: "Turkey Big Boss", text: "Toasted sub with turkey, bacon, melted Swiss, tomato and Russian dressing.", photo: "/menu-board/turkey-big-boss.jpg",
    price: { label: "Full sub", item: `${SUBS}|Turkey Big Boss`, variant: "Full Sub" }, extras: [["Half sub", `${SUBS}|Turkey Big Boss`, "1/2 Sub"], ["Wrap", `${SUBS}|Turkey Big Boss`, "Wraps"]] },
  { key: "ogdens", kicker: "Only in Ogdensburg", name: "The Ogdensburger", text: "A bacon burger stacked between two grilled cheese sandwiches used as the buns.", price: { label: "Just", item: "Burgers|Ogdensburger" } },
  { key: "wildwest", kicker: "Saddle up", name: "Wild West Burger", text: "Double cheeseburger with bacon, an onion ring and barbecue sauce.", price: { label: "Just", item: "Burgers|Wild West Burger" } },
  { key: "fathead", kicker: "Share it, or don't", name: "Fathead Special", text: "Four pizza logs, four mozzarella sticks and four wings with marinara. Pick your wing sauce.", price: { label: "Only", item: "Appetizers|Fathead Special" } },
  { key: "order", kicker: "Skip the wait", name: "Order ahead", text: "Scan with your phone camera or visit ordercornerdeli.com. Pick up when it's ready.", qr: true },
  // Season promos
  { key: "sheet", kicker: "Feeding the trick-or-treat crew?", name: "Sheet Pizza", text: "A full sheet pizza for your Halloween party. Order ahead and pick it up hot.", price: { label: "Just", item: "Pizza and Wings|Pizza", variant: "Sheet Pizza" } },
  { key: "platter", kicker: "Hosting this year?", name: "Party Platters", text: "Deli meat platters and deli salads by the pound for family and office parties.", price: { label: "Meat platter", item: "Deli Platters|Meat Platter" } },
  { key: "turkeyfree", kicker: "Our Thanksgiving tradition", name: "Free turkey dinners", text: "On Thanksgiving Day, Corner Deli gives away free turkey dinners. Ask at the counter for details.", badge: { label: "Thanksgiving", text: "Nov 26" } },
  { key: "hotturkey", kicker: "Thanksgiving all month", name: "Hot Turkey Dinner", text: "Hot turkey dinner from our Hot Meals menu, ready any day of the week.", price: { label: "Just", item: "Hot Meat Meals|Hot Turkey" } },
  { key: "giftcard", kicker: "For everyone on your list", name: "Corner Deli gift cards", text: "The easy gift for coworkers, teachers and the whole family. Ask at the counter.", badge: { label: "Give the gift of", text: "Subs!" } },
];

/**
 * All TVs follow one timeline so they change screens at the same moment: slot n lasts
 * SLOT_SECONDS[n] on every TV, counted from the server's clock. Every TV needs one entry per slot.
 */
export const SLOT_SECONDS = [12, 8, 12, 8];
export const MENU_TVS: { name: string; slots: string[] }[] = [
  { name: "Menu TV 1", slots: ["m:pizza", "p:breakfast", "m:subs", "p:tbb"] },
  { name: "Menu TV 2", slots: ["m:burgers", "p:ogdens", "m:dinners", "p:wildwest"] },
  { name: "Menu TV 3", slots: ["m:apps", "p:fathead", "m:apps", "p:order"] },
];
/** Shown in a promo slot whose item is sold out or missing, so the TVs stay in step. */
const FALLBACK_PROMO = "order";

/** Ticker lines: [bold, text]; "{item|size}" in the text becomes that POS price. */
export const TICKER: [string, string][] = [
  ["Order ahead", "ordercornerdeli.com"], ["Fathead Special", "{Appetizers|Fathead Special}"], ["Breakfast Pizza", 'from {Pizza and Wings|Breakfast Pizza|Small 12"}'],
  ["Fish Fry Dinner", "{Fish|Fish Fry Dinner - 1 Side}"], ["20 wings", "{Pizza and Wings|Wings|20 Wings}"], ["Meat Platter for parties", "{Deli Platters|Meat Platter}"], ["The Ogdensburger", "{Burgers|Ogdensburger}"],
];

export const SEASONS: SeasonSpec[] = [
  { key: "halloween", from: "10-21", to: "10-31", ribbon: "Happy Halloween from Corner Deli",
    swap: { breakfast: "sheet", ogdens: "sheet", fathead: "platter" },
    ticker: [["Halloween party?", "Sheet Pizza {Pizza and Wings|Pizza|Sheet Pizza}"], ["50 wings", "{Pizza and Wings|Wings|50 Wings}"], ["Meat Platter", "{Deli Platters|Meat Platter}"]] },
  { key: "thanksgiving", from: "11-12", to: "11-26", ribbon: "Happy Thanksgiving from Corner Deli",
    swap: { breakfast: "turkeyfree", ogdens: "turkeyfree", wildwest: "hotturkey", fathead: "turkeyfree" },
    ticker: [["Free turkey dinners", "Thanksgiving Day"], ["Hot Turkey Dinner", "{Hot Meat Meals|Hot Turkey}"], ["Meat Platter", "{Deli Platters|Meat Platter}"]] },
  { key: "christmas", from: "11-27", to: "12-25", ribbon: "Merry Christmas from Corner Deli",
    swap: { breakfast: "giftcard", ogdens: "giftcard", wildwest: "platter", fathead: "giftcard" },
    ticker: [["Gift cards", "ask at the counter"], ["Holiday party platters", "from {Deli Platters|Meat Platter}"]] },
];

/** The season showing on a store-time month-day ("10-31"), or everyday. */
export function seasonFor(monthDay: string): SeasonKey {
  return SEASONS.find((season) => season.from && season.to && monthDay >= season.from && monthDay <= season.to)?.key ?? "everyday";
}

// ---------- building a board from POS prices ----------

export type BoardPrice = { text: string; soldOut: boolean };
export type BoardBlock =
  | { kind: "grid"; title: string; note?: string; columns: string[]; rows: { label: string; prices: (BoardPrice | null)[] }[] }
  | { kind: "list"; title: string; note?: string; rows: { label: string; note?: string; price: BoardPrice }[] }
  | { kind: "feature"; title: string; text: string; price: BoardPrice };
export type BoardScreen =
  | { kind: "menu"; key: string; title: [string, string]; tag: [string, string]; layout: "two" | "three"; columns: BoardBlock[][] }
  | { kind: "promo"; key: string; kicker: string; name: string; text: string; badgeLabel: string; badgeText: string; extras: string; photo?: string; qr?: boolean; example: boolean };
export type Board = { tv: number; name: string; season: SeasonKey; ribbon: string; screens: BoardScreen[]; ticker: [string, string][]; missing: string[] };

export const money = (cents: number) => (cents / 100).toFixed(2);

/** One item's price: the named size, its only size, or its base price. */
function lookup(index: PriceIndex, missing: Set<string>, item: string, variant?: string): { cents: number; available: boolean } | null {
  const found = index.get(item.toLowerCase());
  if (!found) { missing.add(item); return null; }
  if (variant) {
    const size = found.variants.find((v) => v.name.toLowerCase() === variant.toLowerCase());
    if (!size) { missing.add(`${item} (${variant})`); return null; }
    return { cents: size.priceCents, available: found.available && size.available };
  }
  if (found.variants.length === 1) return { cents: found.variants[0].priceCents, available: found.available && found.variants[0].available };
  return { cents: found.basePriceCents, available: found.available };
}

function buildBlock(block: BlockSpec, index: PriceIndex, missing: Set<string>): BoardBlock | null {
  if (block.kind === "feature") {
    const p = lookup(index, missing, block.item);
    return p ? { kind: "feature", title: block.title, text: `${block.text} · $${money(p.cents)}`, price: { text: money(p.cents), soldOut: !p.available } } : null;
  }
  if (block.kind === "grid") {
    const rows = block.rows.map((row) => ({
      label: row.label,
      prices: block.columns.map((column) => {
        const item = row.item ?? column.item ?? "", variant = row.variant ?? column.variant;
        // A size the item doesn't come in (a breakfast sheet pizza, a meatball wrap) shows a dash.
        const found = index.get(item.toLowerCase());
        if (found && variant && !found.variants.some((v) => v.name.toLowerCase() === variant.toLowerCase())) return null;
        const p = lookup(index, missing, item, variant);
        return p ? { text: money(p.cents), soldOut: !p.available } : null;
      }),
    })).filter((row) => row.prices.some(Boolean));
    return rows.length ? { kind: "grid", title: block.title, note: block.note, columns: block.columns.map((c) => c.label), rows } : null;
  }
  const rows = block.rows.flatMap((row) => {
    const parts = row.items ? row.items.map((item) => lookup(index, missing, item)) : row.variants ? row.variants.map((v) => lookup(index, missing, row.item!, v)) : [lookup(index, missing, row.item!)];
    if (parts.some((p) => !p)) return [];
    const prices = parts as { cents: number; available: boolean }[];
    return [{ label: row.label, note: row.note, price: { text: prices.map((p) => money(p.cents)).join(" / "), soldOut: prices.every((p) => !p.available) } }];
  });
  return rows.length ? { kind: "list", title: block.title, note: block.note, rows } : null;
}

function fillPrices(text: string, index: PriceIndex, missing: Set<string>): string | null {
  let ok = true;
  const out = text.replace(/\{([^}]+)\}/g, (_, ref: string) => {
    const [category, name, size] = ref.split("|");
    const p = lookup(index, missing, `${category}|${name}`, size);
    if (!p) { ok = false; return ""; }
    return `$${money(p.cents)}`;
  });
  return ok ? out : null;
}

function buildPromo(key: string, index: PriceIndex, missing: Set<string>): BoardScreen | null {
  const promo = PROMOS.find((p) => p.key === key);
  if (!promo) { missing.add(`promo ${key}`); return null; }
  let badgeLabel = promo.badge?.label ?? "", badgeText = promo.badge?.text ?? "";
  if (promo.price) {
    const p = lookup(index, missing, promo.price.item, promo.price.variant);
    if (!p || !p.available) return null; // never advertise a missing or sold-out item
    badgeLabel = promo.price.label; badgeText = `$${money(p.cents)}`;
  }
  const extras = (promo.extras ?? []).flatMap(([label, item, size]) => {
    const p = lookup(index, missing, item, size);
    return p ? [`${label} $${money(p.cents)}`] : [];
  }).join(" · ");
  return { kind: "promo", key: promo.key, kicker: promo.kicker, name: promo.name, text: promo.text, badgeLabel, badgeText, extras, photo: promo.photo, qr: promo.qr, example: false };
}

/** Builds one TV's board (tv is 1-based) for a season from the POS price index. */
export function buildBoard(tv: number, season: SeasonKey, index: PriceIndex): Board {
  const spec = MENU_TVS[tv - 1] ?? MENU_TVS[0];
  const seasonSpec = SEASONS.find((s) => s.key === season);
  const missing = new Set<string>();
  const screens = spec.slots.flatMap((slot): BoardScreen[] => {
    const [kind, key] = slot.split(":");
    if (kind === "p") {
      const promo = buildPromo(seasonSpec?.swap[key] ?? key, index, missing) ?? buildPromo(FALLBACK_PROMO, index, missing);
      return promo ? [promo] : [];
    }
    const screen = MENU_SCREENS.find((s) => s.key === key);
    if (!screen) return [];
    const columns = screen.columns.map((col) => col.flatMap((b) => { const built = buildBlock(b, index, missing); return built ? [built] : []; }));
    return [{ kind: "menu", key: screen.key, title: screen.title, tag: screen.tag, layout: screen.layout, columns }];
  });
  const ticker = [...(seasonSpec?.ticker ?? []), ...TICKER].flatMap(([bold, text]): [string, string][] => {
    const filled = fillPrices(text, index, missing);
    return filled === null ? [] : [[bold, filled]];
  });
  return { tv: MENU_TVS.indexOf(spec) + 1, name: spec.name, season, ribbon: seasonSpec?.ribbon ?? "", screens, ticker, missing: [...missing].sort() };
}
