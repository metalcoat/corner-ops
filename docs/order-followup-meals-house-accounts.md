# Order Follow-up, Employee Meals, and House Accounts

## Goal

Extend the shared ordering platform so repeat callers can continue an existing order without starting over, employees can receive controlled meal comps tied to qualifying shifts, and approved customers can charge orders to a running house account.

These features must work across the POS and AI phone workflow without weakening payment security or auditability.

## Returning caller / order follow-up

When a caller reaches the AI, caller ID should first resolve the customer and then search for recent relevant orders. The AI should distinguish between a new order and common follow-up intents such as:

- pay an existing unpaid order
- add an item to an active order
- change an item that is still editable
- ask about order status / pickup time / delivery status
- call back after a failed payment
- continue an interrupted AI order
- discuss a complaint or remake

The AI should not force the customer to repeat the entire order when a recent matching order is available.

Example:

```text
AI: I found your pickup order from a few minutes ago for a jumbo pizza and 20 wings. Are you calling about that order?
Customer: Yes, I need to add an order of fries and pay for everything.
```

### Matching rules

Caller ID is a lookup hint, not sufficient authorization by itself. The AI can use:

- normalized caller phone
- matched customer ID
- recent active orders for that customer/phone
- order source and business
- order time
- order status
- fulfillment type
- outstanding balance

The customer should confirm the relevant order before consequential changes or payment.

### Adding to an existing order

If an order is still editable, additions can be made directly to the existing order with a new order version.

If the order has already been sent to the kitchen, the system may still allow an approved add-on, but it must create a delta event and a clearly marked **ADD-ON** kitchen ticket containing only the new/changed items so the kitchen does not remake the original order.

If the original order is closed or otherwise locked, create a linked supplemental order rather than silently modifying historical order facts.

Order relationships should support purposes such as:

- add-on
- payment follow-up
- remake/replacement
- complaint resolution

### Paying on callback

If a recent order has an amount due, the AI can offer to take payment.

If the customer has an eligible saved payment method, the AI can say something like:

> I have a Visa ending in 4242 saved. Your balance is $31.74. Would you like me to use that card?

The customer must explicitly approve the amount and payment method before the charge tool is called.

If no reusable payment method exists, the caller is transferred into the secure card-entry/tokenization flow. The AI must never hear, receive, transcribe, or store PAN/CVV/PIN.

A previous card number is not assumed reusable merely because the customer paid by card before. Reuse is allowed only when the payment provider has supplied a reusable token/payment-method reference and the required customer consent is recorded.

### Incremental payment after an add-on

If an already-paid customer calls back and adds items, charge only the incremental amount whenever possible rather than charging the entire order again.

Example:

```text
Original order paid        $38.72
Added fries                 $6.49
Additional tax              $0.52
---------------------------------
NEW CHARGE                  $7.01
```

The original payment remains intact. The add-on creates its own payment transaction and audit event.

## Saved payment method model

Corner Ops stores only processor references and non-sensitive display metadata:

- customer ID
- business / merchant account
- processor
- processor customer reference
- processor payment-method/token reference
- card brand
- last four
- expiration month/year where returned by provider
- reusable/active state
- consent source and timestamp

Never store PAN, CVV, PIN, track data, or raw DTMF payment digits.

## Employee meal comp

Employee meals are a controlled tender/discount workflow tied to an actual shift, not a generic discount button.

Initial policy direction:

- one employee meal for a qualifying 6-hour shift
- policy is configurable by business
- employee must be identified in the POS
- system looks up the employee's current/relevant `time_entries` shift
- the meal comp is linked to the employee, shift, and order
- duplicate use for the same shift is blocked unless a manager explicitly overrides it

The exact menu/value rules should remain configurable so ownership can decide later whether the benefit means:

- one eligible meal/item
- a dollar ceiling
- selected categories only
- selected items only
- exclusions for premium items/add-ons
- percentage comp up to a limit

### POS flow

```text
EMPLOYEE MEAL
Employee: Jane Smith
Shift: 11:00 AM - 7:00 PM
Worked / scheduled: 8:00

Eligibility: QUALIFIED
Meals used this shift: 0 of 1

Eligible comp: configured by current policy

[ APPLY EMPLOYEE MEAL ]
```

If not eligible, the POS shows the reason instead of merely hiding the button.

Examples:

- shift under minimum duration
- no active/matching shift
- meal already used
- item not eligible
- policy inactive

Manager overrides must capture who approved the override and why.

### Reporting

Employee meal reporting should show:

- employee
- shift/date
- order number
- retail amount
- amount comped
- items comped
- manager override if any
- monthly cost by employee/business

This provides enough data to refine the policy after seeing actual usage.

## House accounts

A house account is an accounts-receivable customer account, not a fake cash payment.

Example use case: an approved tenant/customer places many orders over several weeks and pays the accumulated balance every month or two.

### House-account behavior

An approved customer can be attached to a house account. At checkout the POS can use:

```text
PAYMENT
○ Cash
○ Card
● House Account - Waterfront Tenant
```

Charging the house account settles the individual order from the restaurant workflow's perspective while increasing the house-account receivable balance.

The order records a `house_account` tender. It must not be reported as cash or card revenue collection.

### House-account ledger

Every account uses an immutable ledger. Entries include:

- charge from order
- payment received
- credit
- refund/reversal
- manual adjustment

The displayed balance is calculated from ledger entries rather than trusting an editable balance field.

Example:

```text
WATERFRONT TENANT

Jul 03   Order #18221        +$47.22
Jul 11   Order #18407        +$31.84
Jul 18   Order #18613        +$63.10
Aug 02   Order #19002        +$28.40
Aug 11   Payment            -$100.00
-----------------------------------
BALANCE                      $70.56
```

### Account configuration

Each account can support:

- account name
- authorized customers
- active / hold / closed status
- optional credit limit
- optional payment terms
- billing contact
- notes
- manager-only charging if desired

An account on hold cannot receive new charges without an authorized override.

### Payments against house account

When the customer makes one large payment, record one house-account payment and reduce the account balance. The system can show which charges remain outstanding and can later support FIFO allocation, statements, aging, and account history.

### AI behavior

The AI may recognize that a caller belongs to an approved house account, but it should not automatically charge the account simply because caller ID matches.

The AI can say:

> I have this customer authorized on the Waterfront Tenant house account. Would you like this order charged to that account?

The house-account policy engine decides whether the caller/customer is authorized and whether the account is active and within any configured limit.

## Shared tender model

The POS should eventually treat payment/settlement methods as explicit tenders rather than inferring them from `payment_status` alone. Tender types should include at minimum:

- cash
- card
- house account
- employee meal comp
- manager comp / store credit where enabled

This allows one order to contain multiple tenders while keeping cash, card, comps, and receivables financially distinct.

## Audit requirements

Every consequential action should record actor, timestamp, order/customer/account references, and relevant before/after state. At minimum audit:

- caller matched to prior order
- order reopened/continued
- add-on items
- saved payment method selected
- payment authorization/decline result using sanitized metadata only
- employee meal eligibility decision
- employee meal comp/override
- house-account charge
- house-account payment/credit/adjustment

The AI can request these actions through tools, but deterministic backend policy remains authoritative.
