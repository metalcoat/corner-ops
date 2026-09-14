# Roadmap: Earn Your Jumbo / The Corner Deli Pizza Gauntlet

Status: **Planning only — do not implement or deploy until explicitly approved.**

This document is the running backlog for a difficult but beatable Corner Deli browser game. Continue adding ideas here until the owner explicitly says to build it.

## Product goal

Build a polished restaurant-POS-meets-arcade game in which a successful six-stage campaign takes approximately 2–4 active hours, supports save/resume, and can ultimately award one real Jumbo Cheese Pizza. It should be chaotic, funny, skill-based, replayable, responsive on desktop/tablet, and usable on mobile.

## Core pizza loop

- Read and manage tickets on a ticket rail.
- Choose Small (12″), Regular (14″), or Jumbo (16″); interpret Medium as Regular and Large as Jumbo.
- Stretch dough, portion sauce and cheese, distribute toppings, bake, rotate, pull, cut, box, and match to the correct customer.
- Use tactile pointer/touch interactions and drag-and-drop where practical.
- Track sauce, cheese, toppings, distribution, bake, cut, and overall order accuracy.
- Begin with exact ounce guidance, gradually remove measurement displays, and teach visual portion memory.
- Support several active pizzas and oven timers at higher levels.
- Perfect-order combos: 3 = 1.25×, 5 = 1.5×, 10 = 2×, 20 = Zen Mode.
- Allow an unfair complaint to destroy a perfect combo for authentic comedic pain.

## Player systems

Track shift profit, sanity, reputation, accuracy, completed orders, pizzas made, complaints, remakes, waste, tips, combo, highest combo, and unreasonable complaints survived. Failure can result from bankruptcy, zero sanity, collapsed reputation, or catastrophic shift failure. Difficulty should be severe but understandable and learnable.

## Campaign

1. **Training Shift:** one pizza, full guidance, simple tickets, control tutorial.
2. **Dinner Rush:** simultaneous tickets, more toppings, customer patience, oven management.
3. **Friday Night:** 3–6 active tickets, phones, online and pickup orders, interruptions.
4. **Football Sunday:** large orders, simplified wings/sides, multiple ovens, intense timing.
5. **Full Collapse:** equipment, staffing, printer, internet, delivery-app, and complaint failures.
6. **Final Rush:** 7:52 PM, closing pressure, existing tickets, and a final 14-pizza order.

Stage quotas and pacing must be tuned with playtests so a first successful campaign is roughly 2–4 active hours without using artificial idle time.

## Boss orders

- Little League Team: 8 pizzas, 60 wings, 4 fries.
- Office Order: 12 different pizzas with separate modifications.
- The Guy Who Knows the Owner: complex order and alleged discount.
- Sunday Football: 10 Jumbo pizzas, 100 wings, 4 large fries, requested in 20 minutes.
- Final 7:52 PM call: 14 different pizzas while existing orders remain active.

## Random-event engine

Events need title, message, weighted probability, minimum difficulty, cooldown, stat effects, optional player choices, and optional follow-ups. Seed at least 30–50 at launch and keep the catalog data-driven.

Planned incidents include:

- Correctly portioned cheese complaint with a full refund because the customer remains extremely confident.
- “These used to be loaded and now they are shit,” despite unchanged portions.
- Well-done pizza is complained about for being overcooked.
- Light-cheese pizza does not have enough cheese.
- Customer denies ticketed onions.
- Customer asks where the order is after 90 seconds.
- Pickup customer asks where the driver is.
- Delivery-app driver arrives 17 minutes early and stares at staff.
- Customer ordered from the wrong restaurant and expects Corner Deli to fix it.
- “I know the owner” and “I’ve been coming here for 30 years.”
- Employee calls in and is spotted elsewhere.
- Printer paper, internet, oven-temperature, dropped-pizza, phone, closing-order, manager, Facebook-price, contradictory-note, early-arrival, and late-arrival incidents.
- Rare positive events such as a sincere compliment, patient regular, unexpectedly good tip, and the **MIRACLE**: “Everything was great, thank you!”

### Newly added incidents/mechanics

- **EMPLOYEE HIT A DEER:** An employee calls to say they hit a deer. The shift loses a worker, sanity drops, and ticket pressure rises. This can chain into the complaint below.
- **ANTLERS IN THE DRIVEWAY:** A customer is upset that antlers were left in their driveway. The event should maintain deadpan restaurant logic, cause a reputation/sanity choice, and potentially follow the deer incident after a delay.
- **WING SAUCE SHAKEN UP:** Add a tactile wing-side task in later stages. Wings and sauce must be placed in a lidded bowl and shaken/tossed. Poor shaking creates uneven coverage; excessive shaking risks a lid failure, spilled wings, waste, and a remake. A phone vibration/accelerometer option could be explored on mobile, with pointer/touch shaking as the universal control.

## Impossible choices

At selected moments, present several simultaneous emergencies—burning pizzas, ringing phone, register customer, new online order—and allow only one immediate action. Ignored tasks receive realistic consequences. This should teach restaurant pressure rather than merely applying random stat damage.

## Save, validation, reward, and anti-cheat

- Local storage may preserve visual state, settings, and resumable progress, but never prize eligibility.
- Server records must contain run ID, secret run credential, milestones, sequence numbers, active play time, score/profit progression, stage completion, and important checkpoints.
- Server must reject impossible time, score, order-count, and stage jumps and issue reward codes itself.
- Completion creates a unique, single-use code such as `JUMBO-7K4P-X92M`.
- Store code, run ID, issue/completion timestamps, redemption status, prize, statistics, validation metadata, and optional customer identity later.
- Manager-only admin lookup should show completion evidence and atomically mark a valid code redeemed.
- Initial prize: one free Jumbo Cheese Pizza; toppings remain regular price. Terms and expiration stay configurable.
- Before public release, add rate limiting, abuse monitoring, privacy/terms, per-person/device rules, and transactional POS redemption.

## Leaderboards and run summary

Prepare server-backed rankings for profit, accuracy, fastest valid win, pizzas made, combo, fewest remakes, complaints survived, cheese accuracy, and most money lost while technically correct. The final screen should summarize the full shift with dry humor and show the secure code only after server validation.

## Presentation and sound

- Ticket rail, stainless prep table, ingredient bins, dough station, ovens, timers, queue, HUD, complaint overlays, and progressively messy/chaotic visuals.
- Optional synthesized/open sounds: printer, phone, oven, completion, complaint, register, door, combo, plus mute and volume controls.
- Placeholder Corner Deli branding is acceptable until approved brand assets are selected.
- Responsive layouts prioritize desktop and tablet while retaining a usable mobile control scheme.

## Proposed architecture (not yet authorized for implementation)

- Next.js/React/TypeScript within Corner Ops as an isolated public game route.
- Backend route handlers and PostgreSQL tables for validated runs, checkpoints, rewards, redemptions, and leaderboards.
- Existing POS manager authentication for redemption administration.
- Separate typed configuration for sizes, recipes, portions, prices, stages, difficulty, events, bosses, and prize terms.
- Deterministic/testable scoring engine separated from presentation.
- Web Audio synthesized effects with no copyrighted audio dependency.

## Required verification when implementation is authorized

- Unit tests for scoring, aliases for size names, combos, events, stage progression, anti-cheat rejection, code uniqueness, and one-time redemption.
- Browser tests for the complete assembly loop, simultaneous tickets, oven timing, random choices, save/load, loss, campaign win, responsive layouts, and admin redemption.
- Playtesting to tune a hard but beatable 2–4 hour campaign.
- Production build, development deployment, real-device tablet/touch test, and promotion only after explicit approval.

## Real POS work remaining after the game exists

- Add reward lookup to checkout.
- Apply exactly one Jumbo Cheese Pizza discount while retaining normal topping prices.
- Redeem in the same transaction as order submission and attach run/reward IDs to the order audit trail.
- Decide customer identity, eligibility, expiration, transferability, tax treatment, and final published terms.
