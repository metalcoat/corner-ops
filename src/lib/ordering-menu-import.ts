import { createHash, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingMenuImportSchema } from "@/lib/ordering-menu-import-schema";

export type ImportedModifierOption = {
  sourceId: string;
  name: string;
  priceDeltaCents: number;
  available?: boolean;
  defaultSelected?: boolean;
  includedQuantity?: number;
  sortOrder?: number;
};

export type ImportedModifierGroup = {
  sourceId: string;
  name: string;
  prompt?: string;
  minSelections?: number;
  maxSelections?: number;
  allowOptionQuantity?: boolean;
  sortOrder?: number;
  options: ImportedModifierOption[];
};

export type ImportedMenuItem = {
  sourceId: string;
  name: string;
  description?: string;
  sku?: string;
  basePriceCents: number;
  taxable?: boolean;
  available?: boolean;
  sortOrder?: number;
  modifierGroups?: ImportedModifierGroup[];
};

export type ImportedMenuCategory = {
  sourceId: string;
  name: string;
  sortOrder?: number;
  items: ImportedMenuItem[];
};

export type ImportedMenuSnapshot = {
  source: "rezku" | "json" | "csv" | "manual";
  sourceUrl?: string;
  business: OrderingBusiness;
  capturedAt?: string;
  categories: ImportedMenuCategory[];
};

export type MenuImportWarning = {
  code: "missing_source_id" | "duplicate_source_id" | "duplicate_name" | "invalid_price" | "invalid_modifier_range";
  path: string;
  message: string;
};

export type MenuImportPreview = {
  counts: {
    categories: number;
    items: number;
    modifierGroups: number;
    modifierOptions: number;
  };
  warnings: MenuImportWarning[];
  snapshotHash: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function hashSnapshot(snapshot: ImportedMenuSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function previewImportedMenu(snapshot: ImportedMenuSnapshot): MenuImportPreview {
  const warnings: MenuImportWarning[] = [];
  const ids = new Set<string>();
  const categoryNames = new Set<string>();
  let items = 0;
  let modifierGroups = 0;
  let modifierOptions = 0;

  function checkId(sourceId: string, path: string) {
    const id = clean(sourceId, 300);
    if (!id) {
      warnings.push({ code: "missing_source_id", path, message: "Imported entity has no stable source ID." });
      return;
    }
    if (ids.has(id)) {
      warnings.push({ code: "duplicate_source_id", path, message: `Duplicate source ID: ${id}` });
      return;
    }
    ids.add(id);
  }

  snapshot.categories.forEach((category, categoryIndex) => {
    const categoryPath = `categories[${categoryIndex}]`;
    checkId(category.sourceId, categoryPath);
    const categoryName = clean(category.name).toLowerCase();
    if (categoryNames.has(categoryName)) {
      warnings.push({ code: "duplicate_name", path: categoryPath, message: `Duplicate category name: ${category.name}` });
    }
    categoryNames.add(categoryName);

    const itemNames = new Set<string>();
    category.items.forEach((item, itemIndex) => {
      items += 1;
      const itemPath = `${categoryPath}.items[${itemIndex}]`;
      checkId(item.sourceId, itemPath);
      const itemName = clean(item.name).toLowerCase();
      if (itemNames.has(itemName)) {
        warnings.push({ code: "duplicate_name", path: itemPath, message: `Duplicate item name in category: ${item.name}` });
      }
      itemNames.add(itemName);
      if (!Number.isSafeInteger(item.basePriceCents) || item.basePriceCents < 0) {
        warnings.push({ code: "invalid_price", path: itemPath, message: `Invalid base price for ${item.name}.` });
      }

      (item.modifierGroups || []).forEach((group, groupIndex) => {
        modifierGroups += 1;
        const groupPath = `${itemPath}.modifierGroups[${groupIndex}]`;
        checkId(group.sourceId, groupPath);
        const min = Math.max(0, Math.trunc(group.minSelections ?? 0));
        const max = Math.max(1, Math.trunc(group.maxSelections ?? 1));
        if (max < min) {
          warnings.push({ code: "invalid_modifier_range", path: groupPath, message: `${group.name} has max selections below min selections.` });
        }

        const optionNames = new Set<string>();
        group.options.forEach((option, optionIndex) => {
          modifierOptions += 1;
          const optionPath = `${groupPath}.options[${optionIndex}]`;
          checkId(option.sourceId, optionPath);
          const optionName = clean(option.name).toLowerCase();
          if (optionNames.has(optionName)) {
            warnings.push({ code: "duplicate_name", path: optionPath, message: `Duplicate modifier option: ${option.name}` });
          }
          optionNames.add(optionName);
          if (!Number.isSafeInteger(option.priceDeltaCents)) {
            warnings.push({ code: "invalid_price", path: optionPath, message: `Invalid price adjustment for ${option.name}.` });
          }
        });
      });
    });
  });

  return {
    counts: {
      categories: snapshot.categories.length,
      items,
      modifierGroups,
      modifierOptions,
    },
    warnings,
    snapshotHash: hashSnapshot(snapshot),
  };
}

/**
 * Stores a reviewable import snapshot. Applying the import is deliberately a
 * separate step so a scraper cannot silently overwrite the working menu.
 */
export async function createMenuImportPreview(input: {
  snapshot: ImportedMenuSnapshot;
  createdBy: string;
}): Promise<{ runId: string; preview: MenuImportPreview }> {
  await ensureOrderingMenuImportSchema();
  const preview = previewImportedMenu(input.snapshot);
  const sql = getSql();
  const runId = randomUUID();

  await sql`
    INSERT INTO ordering_menu_import_runs (
      id, business, source, source_url, status, category_count, item_count,
      modifier_group_count, modifier_option_count, warning_count, snapshot, created_by
    ) VALUES (
      ${runId}, ${input.snapshot.business}, ${input.snapshot.source}, ${input.snapshot.sourceUrl || ""}, 'preview',
      ${preview.counts.categories}, ${preview.counts.items}, ${preview.counts.modifierGroups},
      ${preview.counts.modifierOptions}, ${preview.warnings.length}, CAST(${JSON.stringify({ ...input.snapshot, preview })} AS jsonb),
      ${input.createdBy}
    )
  `;

  return { runId, preview };
}
