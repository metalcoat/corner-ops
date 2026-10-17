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

- minimum merchandise order for delivery: **$16.00**
- the delivery fee is added **after** the $16.00 merchandise minimum
- 0-4 miles: **$4.00**
- over 4 through 8 miles: **$7.75**
- working contiguous interpretation for the outer zone: over 8 through 12 miles: **$10.00**
- maximum configured distance: 12 miles

Examples:

- $16.00 food in the 0-4 mile zone -> $20.00 total before any other applicable adjustments/tip
- $16.00 food in the >4-8 mile zone -> $23.75 total
- $16.00 food in the >8-12 mile zone -> $26.00 total

The owner can edit the merchandise minimum, maximum distance, every mileage boundary, and every fee without a code change.

The stated outer range was "10 to 12 miles is $10." The development seed currently uses a contiguous >8-12 mile $10 tier so there is no accidental unpriced 8-10 mile hole. This is a working development interpretation and remains editable before production.

## Under-minimum delivery flow

The preferred behavior is to sell useful food first, then round the merchandise portion up only if the customer does not want anything else.

Example: merchandise subtotal is $14.00 and the customer is in the $4.00 delivery zone.

1. The merchandise minimum is $16.00, so the order is $2.00 short before delivery.
2. The POS/web/AI offers a useful add-on using the upsell rules, such as fries or another side.
3. If the customer declines and still wants delivery, policy may add an explicit **Round up to delivery minimum** adjustment equal to the exact $2.00 shortfall.
4. The merchandise/round-up portion is now $16.00.
5. The $4.00 mileage delivery fee is then added, resulting in a $20.00 order total before any other applicable adjustment or tip.

The round-up is a distinct order adjustment and is reportable. It is not disguised as merchandise and it is separate from the mileage-based delivery fee.

### AI phone wording

The AI should sound like a normal employee rather than reciting a policy document. The intended style is:

> "Would you like to add fries or something, or just have us round it up to the minimum?"

If useful, the AI can include the amount naturally:

> "You're $2 short of the delivery minimum. Would you like to add fries or something, or just have us round it up to the minimum?"

The AI should prefer a relevant add-on suggestion from the upsell engine, but it should not badger the caller. If the caller chooses the round-up, the exact merchandise shortfall is applied automatically by the order engine, then the mileage delivery fee is added normally.

## True minimum bypass

A true bypass means allowing the delivery below the configured $16.00 merchandise minimum **without** adding enough food or charging the remaining round-up.

That is intentionally different from the normal round-up adjustment:

- requires manager/owner authorization
- records who authorized it and why
- records the original minimum, merchandise subtotal, delivery charge, and waived shortfall
- creates a management alert for owner/management review
- appears in exception reporting so repeated bypasses can be reviewed

The AI and website cannot independently grant a true bypass. They can only follow the configured minimum/round-up policy or escalate to an authorized employee.

## Tax-inclusive prices

Menu prices are configured as customer-facing gross prices with tax included.

For inclusive pricing, tax is extracted from the gross taxable amount rather than added to the displayed menu price a second time.

The current tax rate is a business setting and is deliberately not hard-coded into menu item prices. Tax settings include:

- prices include tax: yes/no
- tax rate in basis points
- whether delivery fees are taxable
- whether minimum-order round-up adjustments are taxable

The actual tax rate must be explicitly configured before production. Historical orders snapshot the rate/pricing mode used at the time so changing the current rate never rewrites old sales.

## Configuration ownership

The development API and Deli settings screen support owner/co-owner editing of:

- minimum merchandise order for delivery
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
