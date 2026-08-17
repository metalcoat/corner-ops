#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { execFileSync } from "node:child_process";

loadEnvFile("/opt/corner-ops/.env");

function configureLocalDatabase(): void {
  if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD) {
    throw new Error("Rezku menu commands require explicit local PostgreSQL configuration.");
  }
  const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
  if (!/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Corner Ops PostgreSQL did not resolve to a private Docker address.");
  process.env.DATABASE_DRIVER = "postgres";
  process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
}

configureLocalDatabase();

async function main(): Promise<void> {
const snapshotPath = process.env.REZKU_MENU_SNAPSHOT
  || "/opt/corner-ops/imports/rezku/run-31535112071/normalized/rezku-cornerdeli-normalized.json";
const captureRunId = process.env.REZKU_CAPTURE_RUN_ID || "31535112071";
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
for (const category of snapshot.categories || []) {
  for (const menuItem of category.items || []) {
    for (const group of menuItem.modifierGroups || []) {
      if (group.allowOptionQuantity == null && group.quantityEnabled != null) group.allowOptionQuantity = group.quantityEnabled;
      for (const option of group.options || []) {
        if (option.priceDeltaCents == null && option.basePriceCents != null) option.priceDeltaCents = option.basePriceCents;
      }
    }
  }
}
const command = process.argv[2] || "preview";

const { getDatabaseDriver, assertLocalRezkuImportAllowed } = await import("../src/lib/config");
const { getSql } = await import("../src/lib/db");
const { createMenuImportPreview, applyMenuImportRun, previewImportedMenu } = await import("../src/lib/ordering-menu-import");

type Variant = { sourceId: string; name: string; basePriceCents: number };
type Item = { sourceId: string; name: string; variants?: Variant[]; modifierGroups?: Array<{ sourceId: string; name: string; options: Array<{ sourceId: string }> }> };
const items: Item[] = snapshot.categories.flatMap((category: { items: Item[] }) => category.items);
const groups = items.flatMap((item) => item.modifierGroups || []);
const options = groups.flatMap((group) => group.options || []);
const variants = items.flatMap((item) => item.variants || []);
const preview = previewImportedMenu(snapshot);
const warnings = [...preview.warnings];
const fatalErrors: string[] = [];

function item(name: string): Item | undefined {
  return items.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
}

function validateVariants(name: string, expected: Array<[string, number]>): void {
  const found = item(name);
  if (!found) return void fatalErrors.push(`Missing sanity-check product: ${name}`);
  const actual = new Map((found.variants || []).map((variant) => [variant.name, variant.basePriceCents]));
  for (const [variantName, price] of expected) {
    if (actual.get(variantName) !== price) fatalErrors.push(`${name}: expected ${variantName} at ${price} cents.`);
  }
  if (actual.size !== expected.length) fatalErrors.push(`${name}: expected ${expected.length} variants, found ${actual.size}.`);
}

function validateVariantNames(name: string, expected: string[]): void {
  const found = item(name);
  if (!found) return void fatalErrors.push(`Missing sanity-check product: ${name}`);
  const actual = (found.variants || []).map((variant) => variant.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fatalErrors.push(`${name}: unexpected variant eligibility: ${actual.join(", ")}.`);
}

function validateGroups(name: string, expected: string[]): void {
  const found = item(name);
  if (!found) return void fatalErrors.push(`Missing sanity-check product: ${name}`);
  const actual = new Set((found.modifierGroups || []).map((group) => group.name));
  for (const group of expected) if (!actual.has(group)) fatalErrors.push(`${name}: missing modifier group ${group}.`);
}

validateVariants("Pizza", [["Small 12\"", 1000], ["Regular 14\"", 1250], ["Jumbo Thick 16\"", 1650], ["Jumbo Thin 16\"", 1550], ["Sheet Pizza", 3500]]);
validateVariants("Breakfast Pizza", [["Small 12\"", 1500], ["Regular 14\"", 1750], ["Jumbo Thick 16\"", 2100], ["Jumbo Thin 16\"", 2000]]);
validateVariants("Turkey", [["Full Sub", 1075], ["1/2 Sub", 600], ["Wraps", 900]]);
validateVariants("Turkey Big Boss", [["Full Sub", 1175], ["1/2 Sub", 650], ["Wraps", 1025]]);
validateVariants("Steak", [["Full Sub", 1150], ["1/2 Sub", 675], ["Wraps", 1000]]);
validateVariants("Chicken Bacon Ranch", [["Full Sub", 1200], ["1/2 Sub", 675], ["Wraps", 1050]]);
validateVariants("Wings", [["10 Wings", 1350], ["12 Wings", 1625], ["15 Wings", 2025], ["20 Wings", 2700], ["24 Wings", 3250], ["25 Wings", 3375], ["30 Wings", 4050], ["40 Wings", 5400], ["50 Wings", 6750]]);
validateGroups("Pizza", ["Pizza Toppings", "Pizza Sauce", "Pizza Duration Cooked"]);
validateGroups("Wings", ["Wings Add Ons", "Wing Sauce", "Wing Type (Not Guaranteed)"]);
validateVariantNames("Pizza Sub", ["Full Sub", "1/2 Sub"]);
validateVariantNames("Salami", ["Full Sub", "1/2 Sub"]);
validateVariantNames("Garlic Meatball Pepperoni Sub", ["Full Sub"]);
validateVariantNames("Pepperoni Chicken Parmesan Sub", ["Full Sub"]);

for (const name of ["Chicken Parmesan Sub", "Garlic Meatball Pepperoni Sub", "Meatball Sub", "Pepperoni Chicken Parmesan Sub", "Pizza Sub", "Salami", "Sausage Parmesan Sub"]) {
  const found = item(name);
  if (!found) fatalErrors.push(`Missing wrap-exclusion product: ${name}`);
  else if ((found.variants || []).some((variant) => variant.name.toLowerCase().includes("wrap"))) fatalErrors.push(`${name}: captured data unexpectedly contains Wrap.`);
}

const conflictingSourceIds = warnings.filter((warning) => warning.code === "conflicting_source_id");
if (conflictingSourceIds.length) fatalErrors.push(`${conflictingSourceIds.length} materially conflicting shared source IDs.`);

const sourceIds = new Set<string>();
for (const category of snapshot.categories) {
  sourceIds.add(`category:${category.sourceId}`);
  for (const menuItem of category.items) {
    sourceIds.add(`item:${menuItem.sourceId}`);
    for (const group of menuItem.modifierGroups || []) {
      sourceIds.add(`modifier_group:${group.sourceId}`);
      for (const option of group.options) sourceIds.add(`modifier_option:${option.sourceId}`);
    }
    for (const variant of menuItem.variants || []) sourceIds.add(`variant:${menuItem.sourceId}:${variant.sourceId}`);
  }
}

let existing = 0;
if (getDatabaseDriver() === "postgres") {
  const rows = await getSql()`SELECT entity_type, source_id FROM ordering_menu_source_map WHERE business = 'Corner Deli' AND source = 'rezku'`;
  existing = rows.filter((row) => sourceIds.has(`${row.entity_type}:${row.source_id}`)).length;
}

const report = {
  capture: { workflowRunId: captureRunId, artifact: "rezku-cornerdeli-normalized", snapshotPath, capturedAt: snapshot.capturedAt, sourceUrl: snapshot.sourceUrl },
  counts: {
    categories: snapshot.categories.length, products: items.length, variants: variants.length,
    modifierGroups: new Set(groups.map((group) => group.sourceId)).size,
    modifierGroupOccurrences: groups.length,
    modifierOptions: new Set(options.map((option) => option.sourceId)).size,
    modifierOptionOccurrences: options.length,
    itemModifierRelationships: groups.length,
  },
  changes: { create: sourceIds.size - existing, update: existing, unchanged: 0 },
  aliases: variants.filter((variant) => ["full sub", "1/2 sub", "wraps"].includes(variant.name.toLowerCase())).length,
  conflictingSourceIds,
  unsupportedMappings: [],
  warnings: {
    count: warnings.length,
    byCode: Object.fromEntries([...new Set(warnings.map((warning) => warning.code))].map((code) => [code, warnings.filter((warning) => warning.code === code).length])),
    examples: warnings.slice(0, 20),
  },
  fatalErrors,
};

if (command === "preview") {
  console.log(JSON.stringify(report, null, 2));
  if (fatalErrors.length) process.exitCode = 1;
} else if (command === "apply") {
  assertLocalRezkuImportAllowed();
  console.log(`Applying Rezku capture with driver=${getDatabaseDriver()} environment=local-development run=${captureRunId}`);
  if (fatalErrors.length) throw new Error(`Import refused: ${fatalErrors.join(" ")}`);
  const created = await createMenuImportPreview({ snapshot, createdBy: `local-cli:github-actions-run-${captureRunId}` });
  const result = await applyMenuImportRun({ runId: created.runId, approvedBy: "local-cli", allowWarnings: warnings.every((warning) => warning.code === "duplicate_name") });
  console.log(JSON.stringify({ ...result, captureRunId }, null, 2));
} else {
  throw new Error("Usage: npm run menu:rezku:preview | npm run menu:rezku:apply");
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
