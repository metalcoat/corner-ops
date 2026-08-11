# Delivery Pricing, Minimums, and Tax-Inclusive Menu Pricing

This is part of the replacement POS/AI ordering build. It remains separate from the live Corner Ops application until parallel testing is deliberately started.

## Shared enforcement

Delivery rules are owned by the server-side order engine, not by a particular screen or AI prompt. The same policy is intended to govern:

- Corner Deli employee POS orders, including employee-entered phone orders
- AI phone orders
- website orders
- future kiosk/mobile clients

A client can explain or suggest alternatives, but it cannot confirm a delivery that fails the shared delivery confirmation gate. This keeps the minimum and distance fee from becoming three different answers depending on whether a human, website, or robot happened to take the order.

## Corner Deli working delivery policy

Current development defaults:

- minimum delivery total: **$20.00**
- the configured delivery fee **does count** toward the $20.00 minimum
- 0-4 miles: **$4.00**
- over 4 through 8 miles: **$7.75**
- working contiguous interpretation for the outer zone: over 8 through 12 miles: **$10.00**
- maximum configured distance: 12 miles

With the current bands, that means the merchandise portion only needs to reach:

- **$16.00** in the $4.00 delivery zone
- **$12.25** in the $7.75 delivery zone
- **$10.00** in the $10.00 delivery zone

The owner can edit the minimum, whether the delivery charge counts toward it, maximum distance, every mileage boundary, and every fee without a code change.

The stated outer range was "10 to 12 miles is $10." The development seed currently uses a contiguous >8-12 mile $10 tier so there is no accidental unpriced 8-10 mile hole. This is a working development interpretation, not a claim that 8-10 miles was explicitly specified. The settings are editable before production.

## Under-minimum delivery flow

The preferred behavior is to sell useful food first, then round the order up only if the customer does not want anything else.

Example: merchandise subtotal is $14.00 and the customer is in the $4.00 delivery zone.

1. Merchandise plus delivery is $18.00 against the $20.00 minimum.
2. The order engine reports a $2.00 remaining shortfall.
3. The POS/web/AI should offer a useful add-on using the upsell rules, such as fries or another side.
4. If the customer declines and still wants delivery, policy may add an explicit **Round up to delivery minimum** adjustment equal to the exact $2.00 shortfall.
5. The order then reaches the $20.00 minimum and can continue through the normal delivery/payment rules.

The round-up is a distinct order adjustment and is reportable. It is not disguised as merchandise and it is separate from the mileage-based delivery fee.

### AI phone wording

The AI should sound like a normal employee rather than reciting a policy document. The intended style is:

> "Would you like to add fries or something, or just have us round it up to the minimum?"

If useful, the AI can include the amount naturally:

> "You're $2 short of the delivery minimum. Would you like to add fries or something, or just have us round it up to the minimum?"

The AI should prefer a relevant add-on suggestion from the upsell engine, but it should not badger the caller. If the caller chooses the round-up, the exact remaining shortfall is applied automatically by the order engine.

## True minimum bypass

A true bypass means allowing the delivery below the configured minimum **without** adding enough food or charging the remaining round-up.

That is intentionally different from the normal round-up adjustment:

- requires manager/owner authorization
- records who authorized it and why
- records the original minimum, merchandise subtotal, delivery charge, and waived shortfall
- creates a management alert for owner/management review
- appears in exception reporting so repeated bypasses can be reviewed

The AI and website cannot independently grant a true bypass. They can only follow the configured minimum/round-up policy or escalate to an authorized employee.

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
- whether minimum-order round-up adjustments are taxable

The actual tax rate must be explicitly configured before production. Historical orders snapshot the rate/pricing mode used at the time so changing the current rate never rewrites old sales.

## Configuration ownership

The development API and Deli settings screen support owner/co-owner editing of:

- minimum delivery total
- whether delivery fee counts toward the minimum
- maximum delivery distance
- mileage bands
- delivery price for each band
- tax-inclusive/exclusive mode
- tax rate
- fee taxability
- whether round-up to the minimum is allowed
- whether managers can bypass
- whether bypasses generate management alerts

This configuration remains in the development branch while the live Vercel application continues operating separately.
