# Driver Cash Settlement / Cash All Orders

## Goal

Allow a delivery driver or authorized employee to settle many cash orders from the same business day in one operation instead of opening and cashing out each order individually.

Typical case:

- Driver returns near end of shift/day
- 23 delivery orders are still marked `unpaid` / `cash due`
- Driver selects **CASH ALL**
- POS totals those eligible orders together
- Driver enters the actual cash being turned in
- System settles every included order in one atomic batch and creates one driver cash-settlement record

## Eligibility

The batch selector should default to orders that are:

- same business
- same business day
- assigned to the selected driver, route, or driver shift where known
- delivery orders
- payment method expected as cash / amount due at delivery
- not already fully paid, refunded, cancelled, or included in another completed cash settlement

Managers can optionally expand the list to include other authorized cash-due orders, but the default employee workflow should avoid accidentally collecting somebody else's orders.

## POS workflow

Suggested driver screen:

```text
DRIVER CASH SETTLEMENT

Driver: Aaron
Business Day: Aug 11, 2026

23 CASH ORDERS

Order #18421        $31.42
Order #18426        $22.18
Order #18431        $47.90
...
Order #18507        $18.34

--------------------------------
ORDER TOTALS        $681.44
DELIVERY FEES         $69.00
TIPS RECORDED         $84.00
CASH EXPECTED        $834.44
--------------------------------

[ REVIEW ORDERS ]
[ CASH ALL 23 ORDERS ]
```

Before final settlement, show a confirmation screen:

```text
CASH ALL 23 ORDERS

Expected cash:       $834.44
Cash turned in:      [ 834.44 ]

Difference:            $0.00

[ CONFIRM CASH SETTLEMENT ]
```

If the amount differs, require an explicit reason or manager authorization depending on the configured tolerance.

## Atomic settlement

The settlement must be transactional. Either all selected eligible orders are updated successfully or none are.

For each included order:

- create a payment record for the amount due
- mark the payment method as cash
- update `paid_cents`
- update `amount_due_cents`
- move `payment_status` to `paid` when fully satisfied
- create an order event referencing the settlement batch

Then create one settlement header with:

- settlement ID
- business
- business day
- driver / employee
- driver shift or route if available
- order count
- expected cash
- actual cash received
- over/short amount
- approval state
- employee who submitted it
- manager who approved any variance
- timestamp

The order-to-settlement links must remain auditable.

## Partial exceptions

The review screen must allow an employee to deselect an order before cashing the batch if, for example:

- customer paid by card at the door
- order was not delivered
- driver did not collect payment
- order was reassigned to another driver
- payment amount differs due to an approved correction

Deselecting an order leaves that order open and does not block settlement of the remaining orders.

After the batch is completed, individual orders cannot be silently removed from the settlement. Any correction must create an adjustment/reversal event.

## Tips and driver accountability

Cash tips should not be confused with order amount due.

The system should separately track, where applicable:

- merchandise/tax/delivery amount expected from the customer
- recorded card tips
- recorded cash tips if the driver enters them
- cash owed back to the store
- driver-retained tips according to business policy

The exact payroll/tip treatment should remain configurable rather than being baked into the settlement calculation.

## Permissions

Suggested permissions:

- Driver: settle only orders assigned to their own active/current shift or route
- Manager: settle/reopen/reassign broader cash order groups and approve variances
- Owner: full access and historical reporting

A driver should not be able to mark arbitrary unrelated orders paid merely because the button is satisfying to press.

## Concurrency and safety

When the settlement review screen opens, each order should show its current version/payment state.

At confirmation, revalidate every selected order. If one changed in the meantime, stop the settlement and identify the changed order instead of double-cashing it.

Use an idempotency key for the settlement request so a double click/network retry cannot create duplicate payments.

## Reporting

Reports should support:

- cash settlements by driver
- orders per settlement
- expected vs actual cash
- over/short by driver/date
- unsettled cash orders at close
- orders excluded from a batch and reason
- corrections/reversals

This should also feed the day's cash-drawer / deposit reconciliation without requiring 23 separate payment actions.
