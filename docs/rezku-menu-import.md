# Rezku Menu Import Plan

Source under evaluation for the Corner Deli migration:

`https://order.rezku.com/cornerdeli/cover`

The replacement POS stays development-only while this menu migration is built and reviewed.

## Goal

Use the existing Rezku online-ordering menu as migration input so categories, items, prices, descriptions, modifier groups, modifier options, defaults, availability, and ordering structure do not have to be retyped by hand.

The imported menu is a starting point, not unquestioned truth. Corner Ops remains the source of truth after cutover.

## Why this uses a reviewable import

The public Rezku ordering experience is a browser application. A server-side fetch may not expose the fully rendered menu or the JSON calls that populate it. The migration therefore supports a browser-assisted capture/scrape step followed by a normalized JSON import.

The important safety boundary is:

1. capture/scrape Rezku;
2. normalize the data into the Corner Ops import contract;
3. create an import **preview**;
4. show counts, prices, modifiers, and warnings;
5. owner reviews differences/conflicts;
6. explicitly apply the approved import to the development menu.

A scrape is never allowed to silently overwrite the active menu.

## Normalized import model

The import contract supports:

- categories
- menu items
- descriptions
- SKU when available
- customer-facing price in cents
- taxable flag
- available/unavailable state
- modifier groups
- modifier min/max selections
- modifier options
- option upcharges
- option default selections
- option quantity/included quantity where discoverable

Combo structures can be imported if Rezku exposes them distinctly. If Rezku models a combo as ordinary modifiers, the preview should flag it for conversion into Corner Ops' first-class combo model rather than guessing.

## Source identity

Every imported category/item/modifier can retain its Rezku source ID in `ordering_menu_source_map`. Re-running the import can therefore update the same development records instead of creating duplicates.

The system also stores each preview snapshot and source hash so we can compare later Rezku changes against the last captured version during the parallel migration period.

## Conflict rules

The preview should warn instead of guessing when it encounters:

- missing or duplicate source IDs
- duplicate names that would collide with Corner Ops unique menu names
- invalid or missing prices
- modifier min/max conflicts
- modifier groups with the same visible name but materially different rules
- combinations that appear to be meal/combo structures
- ambiguous default selections

## Browser capture

The next implementation step is a development-only browser capture utility that opens the Rezku page, observes the menu/network data used by the rendered ordering app, and converts that data to the normalized import contract.

This capture utility should run locally or in a deliberate development task, not as a recurring production scraper. Once the migration is complete, normal menu changes are made in Corner Ops itself.
