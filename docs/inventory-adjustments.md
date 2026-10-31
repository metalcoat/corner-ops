# Inventory Adjustments and Quick Loss Tracking

## Goal

Make it fast to correct inventory when stock leaves the business outside a normal sale. Common examples include owner use, damage, spills, spoilage, waste, employee use, count corrections, and receiving errors.

Inventory adjustments must be easy enough to use from the POS during a shift while still leaving a complete audit trail.

## Quick Adjust flow

The POS should expose an **Adjust Inventory** action that opens a simple touch-friendly screen.

Example:

```text
ADJUST INVENTORY

Item: Pepsi 20 oz
Current on hand: 24 each

Quantity change:
[-1] [-2] [-5] [CUSTOM]

Reason:
[ OWNER USE ]
[ DAMAGED ]
[ SPILLED ]
[ SPOILAGE ]
[ WASTE ]
[ COUNT CORRECTION ]
[ OTHER ]

Note: ______________________

[ SAVE ADJUSTMENT ]
```

The operator should also be able to scan/search an item and enter a positive correction when inventory is added or a prior count was too low.

## Inventory movement ledger

Inventory quantity should be based on an immutable movement ledger rather than silently editing a single quantity field.

Each movement records:

- business
- inventory item
- storage/location where applicable
- signed quantity change
- unit
- reason
- optional order/customer/employee/shift references
- note
- actor
- timestamp
- optional unit-cost snapshot for loss reporting

If an adjustment is wrong, create a reversing movement. Do not erase the original event.

## Reason codes

Initial reasons should include:

- sale
- received
- owner_use
- employee_use
- employee_meal
- damaged
- spilled
- spoilage
- waste
- theft_or_missing
- count_correction
- transfer_in
- transfer_out
- return_to_stock
- comp
- other

Reasons can later be made configurable by business.

## Owner use

Owner use is not a cash sale. It reduces on-hand quantity using the `owner_use` reason so it can be reported separately from waste or customer sales.

Example report:

```text
AUGUST INVENTORY ADJUSTMENTS

Owner use                 $184.22
Spilled                    $61.40
Damaged                    $38.10
Spoilage                   $72.44
Count corrections          $19.31
```

The exact accounting treatment can be configured separately. Inventory tracking should preserve the operational fact that stock left inventory and why.

## Employee permissions

Suggested defaults:

- Owner: all adjustments
- Manager: all normal adjustments and count corrections
- Employee: damage/spill/waste with required employee identity and optional note requirement
- large or unusual adjustments: manager PIN/approval

Thresholds should be configurable by quantity and/or estimated cost.

## Units and locations

Inventory items need a base stocking unit such as:

- each
- bottle
- can
- ounce
- pound
- gallon
- case
- package
- pan

Later, unit-conversion rules can support cases that contain individual units, pounds used by ounce, etc.

Locations should be optional but supported from the beginning, for example:

- Walk-in
- Freezer
- Deli line
- Pizza line
- Dry storage
- Bar
- Backup storage

A default location keeps routine adjustments fast.

## Menu integration

Menu items and modifiers may be linked to inventory items or recipes.

Examples:

- bottled Pepsi menu item -> 1 Pepsi bottle
- extra bacon modifier -> configured bacon quantity
- pizza -> dough + sauce + cheese + toppings via recipe

Automatic depletion should only happen when a reliable item/recipe mapping exists.

Reaching zero stock may optionally mark a linked menu item/modifier unavailable. This should be configurable rather than blindly 86ing menu items from an inaccurate count.

## Counting

Physical inventory counts should create count-adjustment movements showing:

- expected quantity
- counted quantity
- variance
- cost variance
- person completing count
- timestamp

Example:

```text
Pepsi 20 oz
System: 31
Counted: 27
Variance: -4

[ SAVE COUNT ]
```

This creates a `count_correction` movement of `-4` rather than overwriting history.

## Reporting

Inventory reporting should support:

- current on-hand by item/location
- low-stock items
- adjustment history
- waste/spoilage/damage by day/week/month
- owner use
- employee use
- variance from physical counts
- estimated cost of losses
- adjustment activity by employee
- sales depletion vs non-sale depletion

## Design principle

Inventory adjustment must take seconds, not minutes. If recording a spilled bottle is more annoying than ignoring it, humans will predictably choose the option that produces worse data. The audit detail belongs behind a very small number of POS taps.
