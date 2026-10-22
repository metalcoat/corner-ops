import assert from "node:assert/strict";
import test from "node:test";
import { buildBoard, MENU_TVS, SLOT_SECONDS, seasonFor, type PriceIndex, type PriceIndexItem } from "../src/lib/menu-board-layout";

const item = (cents: number, variants: [string, number, boolean?][] = [], available = true): PriceIndexItem => ({
  basePriceCents: cents, available, variants: variants.map(([name, priceCents, ok = true]) => ({ name, priceCents, available: ok })),
});
const index = (entries: Record<string, PriceIndexItem>): PriceIndex => new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));

test("menu board: seasons by store date", () => {
  assert.equal(seasonFor("10-20"), "everyday");
  assert.equal(seasonFor("10-21"), "halloween");
  assert.equal(seasonFor("10-31"), "halloween");
  assert.equal(seasonFor("11-12"), "thanksgiving");
  assert.equal(seasonFor("11-27"), "christmas");
  assert.equal(seasonFor("12-26"), "everyday");
});

test("menu board: sub grid uses each size's POS price and dashes sizes an item lacks", () => {
  const board = buildBoard(1, "everyday", index({
    "Subs/Wraps|Turkey": item(600, [["Full Sub", 1075], ["1/2 Sub", 600], ["Wraps", 900]]),
    "Subs/Wraps|Meatball Sub": item(600, [["Full Sub", 1000], ["1/2 Sub", 600]]),
  }));
  const subs = board.screens.find((s) => s.kind === "menu" && s.key === "subs");
  assert.ok(subs && subs.kind === "menu");
  const deli = subs.columns[0][0], hot = subs.columns[1][0];
  assert.ok(deli.kind === "grid" && hot.kind === "grid");
  assert.deepEqual(deli.rows.map((r) => [r.label, r.prices.map((p) => p?.text ?? null)]), [["Turkey", ["6.00", "10.75", "9.00"]]]);
  assert.deepEqual(hot.rows[0].prices.map((p) => p?.text ?? null), ["6.00", "10.00", null]);
  assert.ok(board.missing.includes("Subs/Wraps|Ham"));
});

test("menu board: one-size items charge that size; sold out is marked; pairs join", () => {
  const board = buildBoard(2, "everyday", index({
    "Burgers|Wild West Burger": item(1025, [["", 1025]], false),
    "Burgers|Ogdensburger": item(1100),
    "Side Dishes|Small French Fries": item(300), "Side Dishes|Large French Fries": item(350),
  }));
  const burgers = board.screens.find((s) => s.kind === "menu" && s.key === "burgers");
  assert.ok(burgers && burgers.kind === "menu");
  const list = burgers.columns[0][0];
  assert.ok(list.kind === "list");
  assert.deepEqual(list.rows.map((r) => [r.label, r.price.text, r.price.soldOut]), [["Wild West Burger", "10.25", true], ["Ogdensburger", "11.00", false]]);
  const sides = burgers.columns[2][0];
  assert.ok(sides.kind === "list");
  assert.equal(sides.rows[0].price.text, "3.00 / 3.50");
});

test("menu board: promos never advertise a sold-out item, and seasons swap promos", () => {
  const prices = index({
    "Burgers|Ogdensburger": item(1100), "Burgers|Wild West Burger": item(1025, [], false),
    "Pizza and Wings|Pizza": item(1000, [["Sheet Pizza", 3500]]), "Deli Platters|Meat Platter": item(5500),
  });
  const everyday = buildBoard(2, "everyday", prices).screens.filter((s) => s.kind === "promo").map((s) => s.key);
  // The sold-out Wild West Burger gives its slot to the order-ahead screen, so every TV keeps four slots.
  assert.deepEqual(everyday, ["ogdens", "order"]);
  const halloween = buildBoard(2, "halloween", prices);
  assert.deepEqual(halloween.screens.filter((s) => s.kind === "promo").map((s) => s.key), ["sheet", "order"]);
  assert.equal(halloween.ribbon, "Happy Halloween from Corner Deli");
  assert.ok(halloween.ticker.some(([bold, text]) => bold === "Halloween party?" && text === "Sheet Pizza $35.00"));
});

test("menu board: every TV has one screen per timeline slot", () => {
  for (const tv of MENU_TVS) assert.equal(tv.slots.length, SLOT_SECONDS.length, tv.name);
});
