import { createHash, randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { assertLocalRezkuImportAllowed } from "@/lib/config";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingMenuImportSchema } from "@/lib/ordering-menu-import-schema";
import { applyRezkuVariantSnapshot, type RezkuNormalizedSnapshot } from "@/lib/ordering-rezku-variant-import";
import { ensureOrderingMenuEditorSchema } from "@/lib/ordering-menu-editor-schema";

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
  code: "missing_source_id" | "conflicting_source_id" | "duplicate_name" | "invalid_price" | "invalid_modifier_range";
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

type ImportRunRow = {
  id: string;
  business: OrderingBusiness;
  source: ImportedMenuSnapshot["source"];
  status: string;
  warning_count: number;
  snapshot: ImportedMenuSnapshot & { preview?: MenuImportPreview };
};

type IdRow = { id: string };
type MapRow = { internal_id: string };
type SourceEntityType = "category" | "item" | "modifier_group" | "modifier_option";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashSnapshot(snapshot: ImportedMenuSnapshot): string {
  return hashValue(snapshot);
}

export function previewImportedMenu(snapshot: ImportedMenuSnapshot): MenuImportPreview {
  const warnings: MenuImportWarning[] = [];
  const definitionsByType = new Map<string, Map<string, string>>();
  const categoryNames = new Set<string>();
  let items = 0;
  let modifierGroups = 0;
  let modifierOptions = 0;

  function checkId(entityType: string, sourceId: string, definition: unknown, path: string) {
    const id = clean(sourceId, 300);
    if (!id) {
      warnings.push({ code: "missing_source_id", path, message: "Imported entity has no stable source ID." });
      return;
    }
    const definitions = definitionsByType.get(entityType) || new Map<string, string>();
    const canonical = hashValue(definition);
    const previous = definitions.get(id);
    if (previous && previous !== canonical) {
      warnings.push({ code: "conflicting_source_id", path, message: `Conflicting ${entityType} definitions reuse source ID: ${id}` });
    } else if (!previous) {
      definitions.set(id, canonical);
    }
    definitionsByType.set(entityType, definitions);
  }

  snapshot.categories.forEach((category, categoryIndex) => {
    const categoryPath = `categories[${categoryIndex}]`;
    checkId("category", category.sourceId, { name: clean(category.name) }, categoryPath);
    const categoryName = clean(category.name).toLowerCase();
    if (categoryNames.has(categoryName)) {
      warnings.push({ code: "duplicate_name", path: categoryPath, message: `Duplicate category name: ${category.name}` });
    }
    categoryNames.add(categoryName);

    const itemNames = new Set<string>();
    category.items.forEach((item, itemIndex) => {
      items += 1;
      const itemPath = `${categoryPath}.items[${itemIndex}]`;
      checkId("item", item.sourceId, { name: clean(item.name), basePriceCents: item.basePriceCents }, itemPath);
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
        checkId("modifier_group", group.sourceId, {
          name: clean(group.name), minSelections: group.minSelections ?? 0,
          maxSelections: group.maxSelections ?? 1, allowOptionQuantity: Boolean(group.allowOptionQuantity),
          optionSourceIds: group.options.map((option) => clean(option.sourceId, 300)).sort(),
        }, groupPath);
        const min = Math.max(0, Math.trunc(group.minSelections ?? 0));
        const max = Math.max(1, Math.trunc(group.maxSelections ?? 1));
        if (max < min) {
          warnings.push({ code: "invalid_modifier_range", path: groupPath, message: `${group.name} has max selections below min selections.` });
        }

        const optionNames = new Set<string>();
        group.options.forEach((option, optionIndex) => {
          modifierOptions += 1;
          const optionPath = `${groupPath}.options[${optionIndex}]`;
          checkId("modifier_option", option.sourceId, {
            name: clean(option.name), priceDeltaCents: option.priceDeltaCents, available: option.available !== false,
          }, optionPath);
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

async function mappedInternalId(input: {
  business: OrderingBusiness;
  source: ImportedMenuSnapshot["source"];
  entityType: SourceEntityType;
  sourceId: string;
}): Promise<string | null> {
  const rows = (await getSql()`
    SELECT internal_id
    FROM ordering_menu_source_map
    WHERE business = ${input.business}
      AND source = ${input.source}
      AND entity_type = ${input.entityType}
      AND source_id = ${input.sourceId}
    LIMIT 1
  `) as MapRow[];
  return rows[0]?.internal_id || null;
}

async function rememberSource(input: {
  business: OrderingBusiness;
  source: ImportedMenuSnapshot["source"];
  entityType: SourceEntityType;
  sourceId: string;
  internalId: string;
  payload: unknown;
  runId: string;
}): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO ordering_menu_source_map (
      id, business, source, entity_type, source_id, internal_id,
      source_hash, source_payload, last_import_run_id
    ) VALUES (
      ${randomUUID()}, ${input.business}, ${input.source}, ${input.entityType}, ${input.sourceId}, ${input.internalId},
      ${hashValue(input.payload)}, CAST(${JSON.stringify(input.payload)} AS jsonb), ${input.runId}
    )
    ON CONFLICT (business, source, entity_type, source_id) DO UPDATE SET
      internal_id = EXCLUDED.internal_id,
      source_hash = EXCLUDED.source_hash,
      source_payload = EXCLUDED.source_payload,
      last_import_run_id = EXCLUDED.last_import_run_id,
      last_seen_at = NOW()
  `;
}

async function upsertCategory(input: {
  snapshot: ImportedMenuSnapshot;
  category: ImportedMenuCategory;
  runId: string;
}): Promise<string> {
  const sql = getSql();
  const parts = clean(input.category.name).split(" / ").map((part) => part.trim()).filter(Boolean);
  let parentId: string | null = null;
  if (parts.length > 1) {
    const parentName = parts.slice(0, -1).join(" / ");
    const parents = await sql`
      INSERT INTO ordering_menu_categories (id, business, name, display_name, sort_order, active, presentation_only)
      VALUES (${randomUUID()}, ${input.snapshot.business}, ${parentName}, ${parts[parts.length - 2]}, ${Math.trunc(input.category.sortOrder ?? 0)}, TRUE, TRUE)
      ON CONFLICT (business, name) DO UPDATE SET active = TRUE, updated_at = NOW()
      RETURNING id
    ` as IdRow[];
    parentId = parents[0].id;
  }
  const mapped = await mappedInternalId({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "category",
    sourceId: input.category.sourceId,
  });

  let id = mapped;
  if (id) {
    const updated = (await sql`
      UPDATE ordering_menu_categories
      SET name = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='category' AND entity_id=${id} AND field_name='name') THEN name ELSE ${clean(input.category.name)} END,
          display_name = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='category' AND entity_id=${id} AND field_name='display_name') THEN display_name ELSE ${parts[parts.length - 1] || clean(input.category.name)} END,
          parent_id = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='category' AND entity_id=${id} AND field_name='parent_id') THEN parent_id ELSE ${parentId} END,
          presentation_only = FALSE,
          sort_order = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='category' AND entity_id=${id} AND field_name='sort_order') THEN sort_order ELSE ${Math.trunc(input.category.sortOrder ?? 0)} END,
          active = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='category' AND entity_id=${id} AND field_name='active') THEN active ELSE TRUE END,
          updated_at = NOW()
      WHERE id = ${id} AND business = ${input.snapshot.business}
      RETURNING id
    `) as IdRow[];
    if (!updated.length) id = null;
  }

  if (!id) {
    const rows = (await sql`
      INSERT INTO ordering_menu_categories (id, business, name, display_name, parent_id, presentation_only, sort_order, active)
      VALUES (${randomUUID()}, ${input.snapshot.business}, ${clean(input.category.name)}, ${parts[parts.length - 1] || clean(input.category.name)}, ${parentId}, FALSE, ${Math.trunc(input.category.sortOrder ?? 0)}, TRUE)
      ON CONFLICT (business, name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        parent_id = EXCLUDED.parent_id,
        presentation_only = FALSE,
        sort_order = EXCLUDED.sort_order,
        active = TRUE,
        updated_at = NOW()
      RETURNING id
    `) as IdRow[];
    id = rows[0].id;
  }

  await rememberSource({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "category",
    sourceId: input.category.sourceId,
    internalId: id,
    payload: input.category,
    runId: input.runId,
  });
  return id;
}

async function upsertItem(input: {
  snapshot: ImportedMenuSnapshot;
  categoryId: string;
  item: ImportedMenuItem;
  runId: string;
}): Promise<string> {
  const sql = getSql();
  const mapped = await mappedInternalId({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "item",
    sourceId: input.item.sourceId,
  });
  const price = Math.max(0, Math.trunc(input.item.basePriceCents));

  let id = mapped;
  if (id) {
    const updated = (await sql`
      UPDATE ordering_menu_items
      SET category_id = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='category_id') THEN category_id ELSE ${input.categoryId} END,
          name = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='name') THEN name ELSE ${clean(input.item.name)} END,
          description = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='description') THEN description ELSE ${clean(input.item.description, 5000)} END,
          sku = ${clean(input.item.sku, 200)},
          base_price_cents = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='base_price_cents') THEN base_price_cents ELSE ${price} END,
          taxable = ${input.item.taxable !== false},
          available = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='available') THEN available ELSE ${input.item.available !== false} END,
          active = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='active') THEN active ELSE TRUE END,
          sort_order = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='item' AND entity_id=${id} AND field_name='sort_order') THEN sort_order ELSE ${Math.trunc(input.item.sortOrder ?? 0)} END,
          updated_at = NOW()
      WHERE id = ${id} AND business = ${input.snapshot.business}
      RETURNING id
    `) as IdRow[];
    if (!updated.length) id = null;
  }

  if (!id) {
    const rows = (await sql`
      INSERT INTO ordering_menu_items (
        id, business, category_id, name, description, sku, base_price_cents,
        taxable, available, active, sort_order
      ) VALUES (
        ${randomUUID()}, ${input.snapshot.business}, ${input.categoryId}, ${clean(input.item.name)},
        ${clean(input.item.description, 5000)}, ${clean(input.item.sku, 200)}, ${price},
        ${input.item.taxable !== false}, ${input.item.available !== false}, TRUE, ${Math.trunc(input.item.sortOrder ?? 0)}
      )
      ON CONFLICT (business, category_id, name) DO UPDATE SET
        description = EXCLUDED.description,
        sku = EXCLUDED.sku,
        base_price_cents = EXCLUDED.base_price_cents,
        taxable = EXCLUDED.taxable,
        available = EXCLUDED.available,
        active = TRUE,
        sort_order = EXCLUDED.sort_order,
        updated_at = NOW()
      RETURNING id
    `) as IdRow[];
    id = rows[0].id;
  }

  await rememberSource({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "item",
    sourceId: input.item.sourceId,
    internalId: id,
    payload: input.item,
    runId: input.runId,
  });
  return id;
}

async function upsertModifierGroup(input: {
  snapshot: ImportedMenuSnapshot;
  group: ImportedModifierGroup;
  runId: string;
}): Promise<string> {
  const sql = getSql();
  const mapped = await mappedInternalId({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "modifier_group",
    sourceId: input.group.sourceId,
  });
  const min = Math.max(0, Math.trunc(input.group.minSelections ?? 0));
  const max = Math.max(min, Math.max(1, Math.trunc(input.group.maxSelections ?? 1)));

  let id = mapped;
  if (id) {
    const updated = (await sql`
      UPDATE ordering_modifier_groups
      SET name = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_group' AND entity_id=${id} AND field_name='name') THEN name ELSE ${clean(input.group.name)} END,
          prompt = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_group' AND entity_id=${id} AND field_name='prompt') THEN prompt ELSE ${clean(input.group.prompt, 1000)} END,
          min_selections = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_group' AND entity_id=${id} AND field_name='min_selections') THEN min_selections ELSE ${min} END,
          max_selections = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_group' AND entity_id=${id} AND field_name='max_selections') THEN max_selections ELSE ${max} END,
          allow_option_quantity = ${Boolean(input.group.allowOptionQuantity)},
          active = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_group' AND entity_id=${id} AND field_name='active') THEN active ELSE TRUE END,
          sort_order = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_group' AND entity_id=${id} AND field_name='sort_order') THEN sort_order ELSE ${Math.trunc(input.group.sortOrder ?? 0)} END,
          updated_at = NOW()
      WHERE id = ${id} AND business = ${input.snapshot.business}
      RETURNING id
    `) as IdRow[];
    if (!updated.length) id = null;
  }

  if (!id) {
    const rows = (await sql`
      INSERT INTO ordering_modifier_groups (
        id, business, name, prompt, min_selections, max_selections,
        allow_option_quantity, active, sort_order
      ) VALUES (
        ${randomUUID()}, ${input.snapshot.business}, ${clean(input.group.name)}, ${clean(input.group.prompt, 1000)},
        ${min}, ${max}, ${Boolean(input.group.allowOptionQuantity)}, TRUE, ${Math.trunc(input.group.sortOrder ?? 0)}
      )
      RETURNING id
    `) as IdRow[];
    id = rows[0].id;
  }

  await rememberSource({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "modifier_group",
    sourceId: input.group.sourceId,
    internalId: id,
    payload: input.group,
    runId: input.runId,
  });
  return id;
}

async function upsertModifierOption(input: {
  snapshot: ImportedMenuSnapshot;
  groupId: string;
  option: ImportedModifierOption;
  runId: string;
}): Promise<string> {
  const sql = getSql();
  const mapped = await mappedInternalId({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "modifier_option",
    sourceId: input.option.sourceId,
  });
  const delta = Math.trunc(input.option.priceDeltaCents);

  let id = mapped;
  if (id) {
    const updated = (await sql`
      UPDATE ordering_modifier_options
      SET group_id = ${input.groupId},
          name = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_option' AND entity_id=${id} AND field_name='name') THEN name ELSE ${clean(input.option.name)} END,
          price_delta_cents = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_option' AND entity_id=${id} AND field_name='price_delta_cents') THEN price_delta_cents ELSE ${delta} END,
          available = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_option' AND entity_id=${id} AND field_name='available') THEN available ELSE ${input.option.available !== false} END,
          active = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_option' AND entity_id=${id} AND field_name='active') THEN active ELSE TRUE END,
          sort_order = CASE WHEN EXISTS(SELECT 1 FROM ordering_menu_local_fields WHERE entity_type='modifier_option' AND entity_id=${id} AND field_name='sort_order') THEN sort_order ELSE ${Math.trunc(input.option.sortOrder ?? 0)} END,
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING id
    `) as IdRow[];
    if (!updated.length) id = null;
  }

  if (!id) {
    const rows = (await sql`
      INSERT INTO ordering_modifier_options (
        id, group_id, name, price_delta_cents, available, active, sort_order
      ) VALUES (
        ${randomUUID()}, ${input.groupId}, ${clean(input.option.name)}, ${delta},
        ${input.option.available !== false}, TRUE, ${Math.trunc(input.option.sortOrder ?? 0)}
      )
      ON CONFLICT (group_id, name) DO UPDATE SET
        price_delta_cents = EXCLUDED.price_delta_cents,
        available = EXCLUDED.available,
        active = TRUE,
        sort_order = EXCLUDED.sort_order,
        updated_at = NOW()
      RETURNING id
    `) as IdRow[];
    id = rows[0].id;
  }

  await rememberSource({
    business: input.snapshot.business,
    source: input.snapshot.source,
    entityType: "modifier_option",
    sourceId: input.option.sourceId,
    internalId: id,
    payload: input.option,
    runId: input.runId,
  });
  return id;
}

/**
 * Applies an owner-approved preview to the development menu. The operation is
 * idempotent through source-ID mappings. It never deactivates records merely
 * because a scraper failed to see them; removals require a later reviewed diff.
 */
export async function applyMenuImportRun(input: {
  runId: string;
  approvedBy: string;
  allowWarnings?: boolean;
}): Promise<{ runId: string; applied: true; counts: MenuImportPreview["counts"] }> {
  assertLocalRezkuImportAllowed();
  await ensureOrderingMenuImportSchema();
  await ensureOrderingMenuEditorSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT id, business, source, status, warning_count, snapshot
    FROM ordering_menu_import_runs
    WHERE id = ${input.runId}
    LIMIT 1
  `) as ImportRunRow[];
  const run = rows[0];
  if (!run) throw new Error("Menu import preview was not found.");
  if (run.status === "applied") throw new Error("This menu import has already been applied.");
  if (Number(run.warning_count) > 0 && !input.allowWarnings) {
    throw new Error("This menu import contains warnings. Review them before explicitly approving the import.");
  }

  const snapshot = run.snapshot;
  const preview = snapshot.preview || previewImportedMenu(snapshot);
  try {
    await withTransaction(async () => {
      const transactionSql = getSql();
      await transactionSql`
        UPDATE ordering_menu_import_runs
        SET status = 'approved', approved_by = ${input.approvedBy}, approved_at = NOW(), error_message = ''
        WHERE id = ${run.id}
      `;
      for (const category of snapshot.categories) {
      const categoryId = await upsertCategory({ snapshot, category, runId: run.id });
      for (const item of category.items) {
        const itemId = await upsertItem({ snapshot, categoryId, item, runId: run.id });
        for (const group of item.modifierGroups || []) {
          const groupId = await upsertModifierGroup({ snapshot, group, runId: run.id });
          await transactionSql`
            INSERT INTO ordering_menu_item_modifier_groups (id, item_id, group_id, sort_order)
            VALUES (${randomUUID()}, ${itemId}, ${groupId}, ${Math.trunc(group.sortOrder ?? 0)})
            ON CONFLICT (item_id, group_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
          `;

          for (const option of group.options) {
            const optionId = await upsertModifierOption({ snapshot, groupId, option, runId: run.id });
            await transactionSql`
              INSERT INTO ordering_menu_item_modifier_defaults (
                id, item_id, option_id, default_selected, included_quantity,
                price_delta_override_cents, active
              ) VALUES (
                ${randomUUID()}, ${itemId}, ${optionId}, ${Boolean(option.defaultSelected)},
                ${Math.max(0, Math.trunc(option.includedQuantity ?? 0))}, NULL, TRUE
              )
              ON CONFLICT (item_id, option_id) DO UPDATE SET
                default_selected = EXCLUDED.default_selected,
                included_quantity = EXCLUDED.included_quantity,
                active = TRUE,
                updated_at = NOW()
            `;
          }
        }
      }
      }
      const variantResult = snapshot.source === "rezku"
        ? await applyRezkuVariantSnapshot({ snapshot: snapshot as unknown as RezkuNormalizedSnapshot, runId: run.id })
        : null;
      await transactionSql`
        UPDATE ordering_menu_import_runs
        SET status = 'applied', applied_at = NOW(), error_message = '',
            variant_count = ${variantResult?.variantsApplied ?? 0},
            variant_modifier_price_count = ${variantResult?.modifierPricesApplied ?? 0}
        WHERE id = ${run.id}
      `;
    });
    return { runId: run.id, applied: true, counts: preview.counts };
  } catch (error) {
    await sql`
      UPDATE ordering_menu_import_runs
      SET status = 'failed', error_message = ${error instanceof Error ? error.message : String(error)}
      WHERE id = ${run.id}
    `;
    throw error;
  }
}
