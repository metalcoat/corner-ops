#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  const { generatedItemAliases, menuCatalog, modifierAliases } =
    await import("../src/lib/ordering-ai-tools");
  const catalogs = await Promise.all(
    Array.from({ length: 7 }, (_, offset) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + offset);
      return menuCatalog("Corner Deli", date);
    }),
  );
  const itemMap = new Map(
    catalogs
      .flatMap((catalog) => catalog.flatMap((category) => category.items))
      .filter((item) => item.available)
      .map((item) => [item.id, item]),
  );
  const items = [...itemMap.values()];
  const options = items.flatMap((item) =>
    item.modifiers.flatMap((group: any) =>
      group.options
        .filter((option: any) => option.available)
        .map((option: any) => ({
          item: item.name,
          group: group.name,
          option: option.name,
        })),
    ),
  );
  const itemRows = items.map((item) => ({
    canonical: item.name,
    aliases: generatedItemAliases(item.name),
  }));
  const modifierRows = options.map((row) => ({
    ...row,
    aliases: modifierAliases(row.option, row.group),
  }));
  assert.ok(itemRows.every((row) => row.aliases.length > 0));
  assert.ok(modifierRows.every((row) => row.aliases.length > 0));

  const contextualCollisions = new Map<string, Set<string>>();
  for (const row of modifierRows) {
    for (const alias of row.aliases) {
      const key = `${row.item}\u0000${row.group}\u0000${alias.toLowerCase()}`;
      const names = contextualCollisions.get(key) || new Set<string>();
      names.add(row.option);
      contextualCollisions.set(key, names);
    }
  }
  const ambiguous = [...contextualCollisions.entries()].filter(
    ([, names]) => names.size > 1,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      activeItems: itemRows.length,
      itemSearchTerms: itemRows.reduce(
        (sum, row) => sum + row.aliases.length,
        0,
      ),
      contextualModifierOptions: modifierRows.length,
      modifierSearchTerms: modifierRows.reduce(
        (sum, row) => sum + row.aliases.length,
        0,
      ),
      ambiguousAliasesWithinSameItemAndGroup: ambiguous.length,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
