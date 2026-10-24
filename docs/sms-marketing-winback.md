# Corner Deli SMS Marketing and Win-Back Offers

This feature is part of the replacement POS/ordering build and remains development-only until an SMS transport, compliance review, menu linkage, and explicit production authorization are complete.

## Goal

Allow customers to deliberately sign up for Corner Deli promotional text messages, then use order history to send relevant and restrained win-back offers.

Initial desired campaign:

- Trigger after **25 days with no completed Corner Deli order**.
- Only customers with an **active marketing SMS opt-in** are eligible.
- First offer should be useful rather than generic spam: **$3 off a Turkey Big Boss**.
- Send at most once for a given inactivity episode. A new completed order resets the episode; if the customer later goes inactive again, they can become eligible again.
- If the customer orders before the 25-day threshold, no message is queued.
- The campaign is seeded inactive until the real Turkey Big Boss menu item is linked after menu migration.

Example tone:

> Hey, Corner Deli here. We haven't seen you in a little while. Here's $3 off a Turkey Big Boss: DELI-XXXX. Expires 8/25. Reply STOP to opt out.

Copy is configurable. The AI may help draft campaign copy later, but eligibility, offer amount, item, expiration, consent, and suppression are deterministic business rules.

## Signup by text

The working signup keyword is `DELI`, and it is configurable.

Recommended flow:

1. Customer deliberately texts `DELI` to the configured Corner Deli marketing number.
2. The system records the request and the exact signup disclosure/evidence available at that time.
3. The system asks the customer to reply `YES` to confirm marketing texts.
4. Only after confirmation is the subscription `active`.
5. `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, or `QUIT` immediately changes the marketing subscription to opted out.
6. `HELP`/`INFO` returns help text and is logged.

Marketing consent is intentionally separate from transactional/order-update SMS permission. A phone number used for an order or SMS verification is not automatically enrolled in promotions.

## Consent evidence

The system stores:

- business
- normalized phone number
- status: pending / active / opted out / blocked
- consent source
- disclosure snapshot
- evidence JSON
- requested/confirmed/opt-out timestamps
- immutable consent events

This is designed so the business can answer the question, "Why did this number receive this promotion?" without relying on memory or a checkbox that was overwritten six months later.

## Inactivity eligibility

The first win-back rule is based on the most recent **completed** Corner Deli order for the linked customer.

A customer is eligible only when:

- marketing subscription is active and confirmed
- a completed Corner Deli order exists
- the last completed order is at least 25 days old
- the same campaign has not already been sent for that exact last-order episode
- the campaign is active
- the campaign's required menu item is linked and active for the offer

The unique campaign + subscription + last-order linkage prevents a daily scheduler from texting the same person every morning once they cross day 25, a behavior humans traditionally describe as "blocking the number."

## Offer issuance and redemption

Each win-back text receives its own offer record and code. The offer records:

- campaign
- subscriber/customer
- linked menu item when item-specific
- dollar/percent value
- issue and expiration timestamps
- redeemed order and redemption timestamp
- void state

For the initial campaign the value is 300 cents off the linked Turkey Big Boss item. The expiration period is configurable; the development seed uses 14 days.

The order engine will validate the offer server-side at redemption so a customer cannot edit a URL or browser request into a $300 Turkey Big Boss discount, despite the internet's best efforts.

## Sending window and transport

Marketing settings include a local timezone and quiet window. The development defaults only allow campaign sending during the daytime window outside 7 PM to 10 AM. This is deliberately more conservative than simply blasting messages whenever a background job happens to run.

No SMS provider is selected in this foundation. The transport layer should be pluggable so Corner Ops can use the eventual 3CX/SMS provider or another messaging service without changing campaign eligibility logic.

Provider integration must support STOP suppression and delivery/failure status. If the provider itself blocks a number after STOP, Corner Ops should still retain its own opt-out record rather than trusting a third-party account to be our only memory.

## Compliance guardrails

Before production:

- obtain clear opt-in consent before promotional texting
- preserve disclosure/consent evidence
- identify Corner Deli in promotional messages
- provide an easy STOP opt-out path and honor it promptly
- keep marketing consent separate from transactional messaging
- do not purchase/import a marketing list and treat prior food orders as marketing consent
- review final signup wording, sending number registration, provider/carrier requirements, and applicable federal/state rules before enabling sends

The system defaults marketing to disabled so development data or an incomplete migration cannot accidentally begin a promotional campaign.
