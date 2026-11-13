# Corner Deli Rezku Browser Capture

Captured from `https://order.rezku.com/cornerdeli/cover` on 2026-08-11 using the development-only browser capture workflow. This is source-derived migration data, not a hand-entered reconstruction.

## Capture completeness

The browser reached the live Corner Deli ordering menu and discovered Rezku's `menu-tree` and per-product detail endpoints. The comprehensive pass found **204 menu products and successfully captured 204 product-detail payloads**.

The normalized capture currently produces:

- 23 flattened menu/category paths
- 204 products
- 289 product variants
- 402 item-to-modifier-group occurrences

Shared Rezku modifier groups/options are intentionally preserved by source ID in the import design so they can be deduplicated when applied.

## Pizza is a single item with variants

Rezku product `Pizza` (`873983`) is one product, not five separate menu items. It exposes these variants:

| Rezku variation | Base price |
|---|---:|
| Small 12" | $10.00 |
| Regular 14" | $12.50 |
| Jumbo Thick 16" | $16.50 |
| Jumbo Thin 16" | $15.50 |
| Sheet Pizza | $35.00 |

The product has modifier groups for Pizza Toppings, Pizza Sauce, and Pizza Duration Cooked.

Rezku also returns a variation/modifier price matrix. For ordinary pizza toppings such as Pepperoni, Mushrooms, Onions, Peppers, Sausage, Ham, Bacon, Tomato, Black Olives, and Extra Cheese, the captured matrix shows:

- Small 12": $1.00 per listed topping
- Regular 14": $1.50
- Jumbo Thick 16": $1.50
- Jumbo Thin 16": $1.50
- Sheet Pizza: $3.00

Some modifiers have different amounts from the ordinary topping rate, so the importer must preserve Rezku's exact option-by-variant matrix rather than infer one generic topping price.

Breakfast Pizza is also one product with size variants. Its captured sizes are Small 12" $15.00, Regular 14" $17.50, Jumbo Thick 16" $21.00, and Jumbo Thin 16" $20.00.

## Subs and wraps are variants, not separate products

The captured Subs/Wraps menu contains **32 products**. Rezku models common sub forms as variants on each product, usually `Full Sub`, `1/2 Sub`, and where allowed, `Wraps`.

Examples:

- Turkey: Full Sub $10.75; 1/2 Sub $6.00; Wraps $9.00
- Turkey Big Boss: Full Sub $11.75; 1/2 Sub $6.50; Wraps $10.25
- Steak: Full Sub $11.50; 1/2 Sub $6.75; Wraps $10.00
- Chicken Bacon Ranch: Full Sub $12.00; 1/2 Sub $6.75; Wraps $10.50

The capture confirms that Wrap is **not** universally available. Of the 32 captured Subs/Wraps products, 25 have a Wraps variant and 7 do not.

The seven captured products without a Wraps variant are:

- Chicken Parmesan Sub
- Garlic Meatball Pepperoni Sub
- Meatball Sub
- Pepperoni Chicken Parmesan Sub
- Pizza Sub
- Salami
- Sausage Parmesan Sub

Garlic Meatball Pepperoni Sub and Pepperoni Chicken Parmesan Sub currently expose only a Full Sub variant. The new ordering engine should therefore derive eligibility from the variants actually attached to an item rather than from a broad `sub = wrap eligible` assumption.

## Sub modifier pricing also varies by size

Rezku returns variation-specific modifier pricing for common sub extras. For Turkey, for example, the captured matrix includes:

- Bacon: Full Sub $2.00; 1/2 Sub $1.00
- Double Meat: Full Sub $4.00; 1/2 Sub $2.00
- A1 Sauce: $0.25 on Full and 1/2
- Jalapenos: $0.25 on Full and 1/2

The product also has structured groups such as Sub Mods, Free Cheese, Sub Heavy/Light, and Double Cheese. Other sub products have their own group combinations. The migration must retain each product's actual attached groups instead of assuming every sub uses the same questions.

## Wings are variants too

Rezku models Wings as one product with quantity variants. The captured variants include 10, 12, 15, 20, 24, 25, 30, 40, and 50 Wings, each with its own price. The attached groups include Wings Add Ons, Wing Sauce, and Wing Type (Not Guaranteed).

This reinforces the same model: one logical item plus valid variants and deterministic modifier rules.

## Migration behavior

The replacement ordering model now treats a selectable size/form as an item variant. Variant records own their base price and can override modifier-option pricing. Orders snapshot the selected variant and actual prices used. AI aliases can map natural phrases such as `whole` to the captured `Full Sub` variant without renaming the source variant or inventing a nonexistent form.

If an item does not have a Wrap variant, POS, web, and AI must all refuse/omit Wrap for that item. The model should never rely on the language model to remember which sandwiches happen to wrap well.

The capture and normalization workflows are development-only. They do not apply menu changes to the live Corner Ops application or deploy the replacement POS.
