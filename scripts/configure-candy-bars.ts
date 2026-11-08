#!/usr/bin/env node
// Chris 2026-11-08: new candy from Amazon (arriving 2026-11-10) sells at $2.00 each (menu prices include tax):
// Twix, Peanut M&M's, Crunch, Sour Patch Kids (2 oz), Swedish Fish (2 oz), Reese's Cups, Snickers.
// Missing ones are added to Candy Bars like the existing bars; those seven are set to $2.00. Other candy prices
// are left alone. Every candy item also gets a product photo from scripts/assets/candy-images/.
// Rerunnable: items, prices, aliases and photos already in place are left alone (a photo uploaded by hand is
// never replaced). A photo row whose file is missing from the uploads volume gets its file written back.
//
//   npx tsx scripts/configure-candy-bars.ts                 dev
//   VALIDATION_TARGET=staging npx tsx scripts/configure-candy-bars.ts
// The photo files are written into the app container's /data/uploads volume; MENU_APP_CONTAINER overrides
// which container (default corner-ops-app, or corner-ops-staging-app for staging).
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const PRICE_CENTS = 200;
const CATEGORY = "Candy Bars";
const ACTOR_ID = "candy-bars-2026-11";
const REASON = "Chris 2026-11-08: candy from Amazon at $2.00, product photos for all candy";
const IMAGE_DIR = path.join(__dirname, "assets", "candy-images");
const UPLOADS = "/data/uploads";
const CONTAINER = process.env.MENU_APP_CONTAINER
  || (process.env.VALIDATION_TARGET === "staging" ? "corner-ops-staging-app" : "corner-ops-app");

type Candy = {
  name: string; // name used when the item is created
  match: string[]; // existing names that count as this item (lowercase)
  image: string;
  alt: string;
  priced?: boolean; // one of the seven new candies: create if missing, $2.00
  aliases?: string[];
};

const CANDY: Candy[] = [
  { name: "Twix", match: ["twix"], image: "twix.jpg", alt: "Twix caramel cookie bar", priced: true },
  { name: "Peanut M&M's", match: ["peanut m&m's", "peanut m&ms", "peanut m&m"], image: "peanut-mms.jpg", alt: "Peanut M&M's bag", priced: true, aliases: ["Peanut M&Ms", "Peanut M and M's", "M&M's Peanut"] },
  { name: "Nestle Crunch", match: ["nestle crunch", "crunch", "crunch bar"], image: "nestle-crunch.jpg", alt: "Crunch chocolate bar", priced: true, aliases: ["Crunch", "Crunch Bar"] },
  { name: "Sour Patch Kids", match: ["sour patch kids"], image: "sour-patch-kids.jpg", alt: "Sour Patch Kids 2 oz bag", priced: true, aliases: ["Sour Patch"] },
  { name: "Swedish Fish", match: ["swedish fish"], image: "swedish-fish.jpg", alt: "Swedish Fish 2 oz bag", priced: true },
  { name: "Reeses", match: ["reeses", "reese's", "reese's cups", "reeses cups"], image: "reeses.jpg", alt: "Reese's Peanut Butter Cups", priced: true, aliases: ["Reese's Cups", "Reese's Peanut Butter Cups", "Peanut Butter Cups"] },
  { name: "Snickers", match: ["snickers"], image: "snickers.jpg", alt: "Snickers bar", priced: true },
  { name: "Milky Way", match: ["milky way"], image: "milky-way.jpg", alt: "Milky Way bar" },
  { name: "Starburst", match: ["starburst"], image: "starburst.jpg", alt: "Starburst Original fruit chews" },
  { name: "3 Musketeers", match: ["3 musketeers"], image: "3-musketeers.jpg", alt: "3 Musketeers bar" },
  { name: "Butterfinger", match: ["butterfinger"], image: "butterfinger.jpg", alt: "Butterfinger bar" },
  { name: "Kit Kat", match: ["kit kat"], image: "kit-kat.jpg", alt: "Kit Kat bar" },
  { name: "Nerds Rope", match: ["nerds rope"], image: "nerds-rope.jpg", alt: "Nerds Rope" },
  { name: "Skittles", match: ["skittles"], image: "skittles.jpg", alt: "Skittles Original bag" },
  { name: "Skittles Wild Berry", match: ["skittles wild berry"], image: "skittles-wild-berry.jpg", alt: "Skittles Wild Berry bag" },
];

const normalize = (value: string) => value.toLocaleLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

function storedPath(reference: string) {
  return path.posix.join(UPLOADS, reference.replace(/^local:/, ""));
}
function containerHasFile(file: string) {
  try {
    execFileSync("docker", ["exec", CONTAINER, "test", "-f", file]);
    return true;
  } catch {
    return false;
  }
}
function writeToContainer(file: string, bytes: Buffer) {
  execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", file], { input: bytes });
  if (!containerHasFile(file)) throw new Error(`Photo was not written to ${CONTAINER}:${file}`);
}
function jpegSize(b: Buffer) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 255) { p++; continue; }
    const marker = b[p + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)];
    p += 2 + b.readUInt16BE(p + 2);
  }
  throw new Error("Unreadable JPEG.");
}

async function main() {
  const [{ getSql }, { ensureOrderingMenuEditorSchema }, { mutateMenu }, { ensureOrderingMenuOverrideSchema }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-menu-editor-schema"),
    import("../src/lib/ordering-menu-editor"),
    import("../src/lib/ordering-menu-overrides"),
  ]);
  await ensureOrderingMenuEditorSchema();
  await ensureOrderingMenuOverrideSchema();
  const sql = getSql();
  const actor = { id: ACTOR_ID, business: "Corner Deli" as const };
  const categories = await sql`SELECT id FROM ordering_menu_categories WHERE business='Corner Deli' AND name=${CATEGORY} AND active=TRUE`;
  if (categories.length !== 1) throw new Error(`Expected one active ${CATEGORY} category; found ${categories.length}.`);
  const categoryId = String(categories[0].id);
  const report: Array<Record<string, unknown>> = [];

  for (const candy of CANDY) {
    const rows = await sql`SELECT id, name, base_price_cents FROM ordering_menu_items
      WHERE business='Corner Deli' AND category_id=${categoryId} AND active=TRUE AND LOWER(name) = ANY(${candy.match})`;
    if (rows.length > 1) throw new Error(`More than one active ${candy.name} in ${CATEGORY}.`);
    const entry: Record<string, unknown> = { name: candy.name };
    let itemId: string;
    if (rows[0]) {
      itemId = String(rows[0].id);
      entry.name = rows[0].name;
      entry.priceCents = Number(rows[0].base_price_cents);
      if (candy.priced && Number(rows[0].base_price_cents) !== PRICE_CENTS) {
        await mutateMenu(actor, { action: "update", entity: "item", id: itemId, patch: { basePriceCents: PRICE_CENTS }, reason: REASON });
        entry.priceFromCents = Number(rows[0].base_price_cents);
        entry.priceCents = PRICE_CENTS;
      }
    } else if (candy.priced) {
      itemId = (await mutateMenu(actor, { action: "create_item", categoryId, name: candy.name, basePriceCents: PRICE_CENTS, sortOrder: 0, reason: REASON })).id;
      entry.created = true;
      entry.priceCents = PRICE_CENTS;
    } else {
      report.push({ ...entry, missing: true });
      continue;
    }
    entry.id = itemId;
    if (candy.priced) {
      const variants = await sql`SELECT id, name, base_price_cents FROM ordering_menu_item_variants WHERE item_id=${itemId} AND active=TRUE`;
      for (const variant of variants)
        if (Number(variant.base_price_cents) !== PRICE_CENTS) {
          await mutateMenu(actor, { action: "update", entity: "variant", id: variant.id, patch: { basePriceCents: PRICE_CENTS }, reason: REASON });
          entry[`variant ${variant.name || variant.id} fromCents`] = Number(variant.base_price_cents);
        }
    }
    for (const alias of candy.aliases ?? []) {
      const normalized = normalize(alias);
      if (normalized === normalize(String(entry.name))) continue;
      await sql`INSERT INTO ordering_menu_item_aliases(id,item_id,alias,normalized_alias,active) VALUES(${randomUUID()},${itemId},${alias},${normalized},TRUE)
        ON CONFLICT(item_id,normalized_alias) DO NOTHING`;
    }

    const bytes = readFileSync(path.join(IMAGE_DIR, candy.image));
    const media = (await sql`SELECT id, storage_reference, uploaded_by FROM ordering_menu_media WHERE target_type='item' AND target_id=${itemId} AND is_primary ORDER BY uploaded_at DESC LIMIT 1`)[0];
    if (media) {
      const file = storedPath(String(media.storage_reference));
      if (!containerHasFile(file) && media.uploaded_by === ACTOR_ID) {
        writeToContainer(file, bytes);
        entry.image = "file restored";
      } else entry.image = "kept";
    } else {
      const mediaId = randomUUID();
      const reference = `local:menu/item/${itemId}/${mediaId}.jpg`;
      const [width, height] = jpegSize(bytes);
      writeToContainer(storedPath(reference), bytes);
      await sql`INSERT INTO ordering_menu_media(id,target_type,target_id,storage_reference,alt_text,mime_type,width,height,size_bytes,uploaded_by)
        VALUES(${mediaId},'item',${itemId},${reference},${candy.alt},'image/jpeg',${width},${height},${bytes.length},${ACTOR_ID})`;
      entry.image = "added";
    }
    report.push(entry);
  }
  console.log(JSON.stringify({ category: CATEGORY, categoryId, container: CONTAINER, items: report }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
