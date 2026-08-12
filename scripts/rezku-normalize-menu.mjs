#!/usr/bin/env node

import fs from "node:fs/promises";

const input = process.argv[2] || "tmp/rezku-cornerdeli-discovery.json";
const output = process.argv[3] || "tmp/rezku-cornerdeli-normalized.json";
const capture = JSON.parse(await fs.readFile(input, "utf8"));
const menuEntry = capture.jsonResponses.find((entry) => String(entry.url).includes("/online-ordering/menu-tree"));
if (!menuEntry?.body?.products) throw new Error("Rezku menu-tree payload was not captured.");

const detailMap = new Map();
for (const entry of capture.jsonResponses) {
  if (!String(entry.url).includes("/online-ordering/product?") || !entry.body?.product?.id) continue;
  detailMap.set(Number(entry.body.product.id), entry.body);
}

function cents(value) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid Rezku money value: ${value}`);
  return Math.round(number * 100);
}

function flattenMenus(nodes, path = [], outputRows = []) {
  for (const node of nodes || []) {
    if (node.type === "menu") {
      flattenMenus(node.children || [], [...path, { id: String(node.id), name: String(node.name) }], outputRows);
    } else if (["product", "pizza", "coupon"].includes(node.type)) {
      outputRows.push({ node, path });
    }
  }
  return outputRows;
}

const records = flattenMenus(menuEntry.body.products);
const categories = new Map();

for (const { node, path } of records) {
  if (node.type === "coupon") continue;
  if (!path.length) continue;

  const categoryId = path.map((part) => part.id).join("/");
  if (!categories.has(categoryId)) {
    categories.set(categoryId, {
      sourceId: categoryId,
      name: path.map((part) => part.name).join(" / "),
      path: path.map((part) => ({ sourceId: part.id, name: part.name })),
      items: [],
    });
  }

  const detail = detailMap.get(Number(node.id));
  if (!detail) throw new Error(`Missing Rezku product detail for ${node.id} ${node.name}.`);
  const product = detail.product;
  const modifiersById = new Map();

  const modifierGroups = (detail.modifier_groups || []).map((group, groupIndex) => {
    const options = (group.modifiers || [])
      .filter((modifier) => !modifier.deleted)
      .map((modifier, modifierIndex) => {
        const option = {
          sourceId: String(modifier.id),
          name: String(modifier.name || "").trim(),
          printLabel: modifier.print_label || null,
          priceDeltaCents: cents(modifier.online_price ?? modifier.price),
          availableOnline: modifier.available_online !== false,
          defaultSelected: false,
          sortOrder: Number(modifier.order ?? modifierIndex),
        };
        modifiersById.set(Number(modifier.id), option);
        return option;
      });

    return {
      sourceId: String(group.id),
      name: String(group.name || ""),
      minSelections: Number(group.min ?? 0),
      // Rezku uses null for effectively-unlimited groups. Our deterministic
      // model represents that as the count of currently available options.
      maxSelections: group.max == null ? options.length : Number(group.max),
      quantityEnabled: Boolean(group.quantity_enabled),
      pizzaMode: Boolean(group.pizza_mode),
      sortOrder: groupIndex,
      options,
    };
  });

  const defaultModifierIds = new Set((product.default_modifiers || []).map(Number));
  for (const group of modifierGroups) {
    for (const option of group.options) option.defaultSelected = defaultModifierIds.has(Number(option.sourceId));
  }

  // Rezku can override or disable a modifier for just one product. Keep those
  // facts separate from variant pricing so the importer can reproduce them.
  const itemModifierOverrides = (detail.modifier_prices || [])
    .filter((row) => modifiersById.has(Number(row.modifier_id)))
    .map((row) => ({
      modifierSourceId: String(row.modifier_id),
      variantSourceId: row.variation_id == null ? null : String(row.variation_id),
      priceDeltaCents: row.price == null ? null : cents(row.price),
      disabled: Boolean(row.disabled),
    }));

  const globalModifierPrices = detail.global_modifier_prices || [];
  const variants = (product.variants || []).map((variant, variantIndex) => {
    const variantSourceId = String(variant.variation_id);
    const modifierPrices = globalModifierPrices
      .filter((row) => String(row.variation_id) === variantSourceId && modifiersById.has(Number(row.modifier_id)))
      .map((row) => ({
        modifierSourceId: String(row.modifier_id),
        priceDeltaCents: cents(row.price),
        available: !row.disabled,
      }));

    return {
      sourceId: variantSourceId,
      name: String(variant.name || ""),
      basePriceCents: cents(variant.online_price ?? variant.price),
      available: true,
      sortOrder: variantIndex,
      metadata: {
        inches: variant.inches ?? null,
        slices: variant.slices ?? null,
        feeds: variant.feeds ?? null,
      },
      modifierPrices,
    };
  });

  categories.get(categoryId).items.push({
    sourceId: String(product.id),
    name: String(product.name || node.name || ""),
    type: String(product.type || node.type || "product"),
    description: product.description || "",
    // Variant items display from their lowest selectable price. Orders still
    // require a concrete variant when more than one exists.
    basePriceCents: variants.length
      ? Math.min(...variants.map((variant) => variant.basePriceCents))
      : cents(product.online_price ?? product.price),
    variants,
    modifierGroups,
    itemModifierOverrides,
    metadata: {
      menuId: product.menu_id ?? null,
      freeToppings: product.free_toppings ?? null,
      enableLegacyHalves: Boolean(detail.enable_modifier_legacy_halves),
      pizzaSettings: detail.pizza_settings || null,
    },
  });
}

const snapshot = {
  source: "rezku",
  sourceUrl: capture.sourceUrl,
  business: "Corner Deli",
  capturedAt: capture.capturedAt,
  categories: [...categories.values()],
};

await fs.writeFile(output, JSON.stringify(snapshot, null, 2), "utf8");
const items = snapshot.categories.flatMap((category) => category.items);
console.log(JSON.stringify({
  categories: snapshot.categories.length,
  items: items.length,
  variants: items.reduce((total, item) => total + item.variants.length, 0),
  modifierGroups: items.reduce((total, item) => total + item.modifierGroups.length, 0),
}, null, 2));
