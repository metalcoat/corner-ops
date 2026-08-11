# Delivery Pricing, Minimums, and Tax-Inclusive Menu Pricing

This is part of the replacement POS/AI ordering build. It remains separate from the live Corner Ops application until parallel testing is deliberately started.

## Shared enforcement

Delivery rules are owned by the server-side order engine, not by a particular screen or AI prompt. The same policy is intended to govern:

- Corner Deli employee POS orders, including employee-entered phone orders
- AI phone orders
- website orders
- future kiosk/mobile clients

A client can explain or suggest alternatives, but it cannot confirm a delivery that fails the shared delivery confirmation gate.

## Corner Deli working delivery policy

Current development defaults:

- merchandise minimum: **$20.00**
- delivery fee does **not** count toward the merchandise minimum
- 0-4 miles: **$4.00**
- over 4 through 8 miles: **$7.75**
- working contiguous interpretation for the outer zone: over 8 through 12 miles: **$10.00**
- maximum configured distance: 12 miles

The owner can edit the minimum, maximum distance, every mileage boundary, and every fee without a code change.

The stated outer range was "10 to 12 miles is $10." The development seed currently uses a contiguous >8-12 mile $10 tier so there is no accidental unpriced 8-10 mile hole. The settings are explicitly editable before production.

## Under-minimum delivery flow

The preferred behavior is to sell food rather than charge a meaningless fee.

Example: merchandise subtotal is $14.00 and the minimum is $20.00.

1. The order engine reports a $6.00 shortfall.
2. The POS/web/AI should first offer useful add-ons using the upsell rules, such as fries or another side.
3. If the customer declines and still wants delivery, policy may add an explicit **Minimum order adjustment** equal to the exact $6.00 shortfall.
4. The order then satisfies the minimum economically and can continue through normal delivery/payment rules.

The shortfall fee is a distinct order adjustment and is reportable. It is not disguised as merchandise and it is not the delivery fee.

For AI phone ordering, the normal conversational order is: tell the customer how far short they are, offer something useful such as fries first, and only offer the exact shortfall fee if they decline the food suggestion and still want delivery.

## True minimum bypass

A true bypass means allowing the delivery below the merchandise minimum **without** charging the shortfall fee.

That is intentionally different from the normal minimum-order adjustment:

- requires manager/owner authorization
- records who authorized it and why
- records the original minimum, merchandise subtotal, and waived shortfall
- creates a management alert
- appears in exception reporting so repeated bypasses can be reviewed

The AI and website cannot independently grant a true bypass. They can only follow the configured minimum/shortfall policy or escalate to an authorized employee.

## Tax-inclusive prices

Menu prices are configured as customer-facing gross prices with tax included.

Example concept:

- customer-facing menu price: $10.80
- tax rate: 8.00%
- embedded tax portion: $0.80
- pre-tax sales amount: $10.00

For inclusive pricing, tax is extracted from the gross taxable amount rather than added to the displayed menu price a second time.

The current tax rate is a business setting and is deliberately not hard-coded into menu item prices. Tax settings include:

- prices include tax: yes/no
- tax rate in basis points
- whether delivery fees are taxable
- whether minimum-order adjustments are taxable

The actual tax rate must be explicitly configured before production. Historical orders snapshot the rate/pricing mode used at the time so changing the current rate never rewrites old sales.

## Configuration ownership

The development API and Deli settings screen support owner/co-owner editing of:

- minimum delivery order
- maximum delivery distance
- mileage bands
- delivery price for each band
- tax-inclusive/exclusive mode
- tax rate
- fee taxability
- whether the shortfall fee is allowed
- whether managers can bypass
- whether bypasses generate management alerts

This configuration remains in the development branch while the live Vercel application continues operating separately.
