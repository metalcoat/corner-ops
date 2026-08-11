# Ordering Hours, ASAP Estimates, Future Orders, and Kitchen Timing

This design applies to the replacement ordering platform only. It remains development-only and is not part of the live Corner Ops workflow yet.

## Shared rule

Restaurant availability and promised-time logic belong to the shared order engine. The employee POS, website, AI phone agent, and later kiosk/mobile clients must use the same hours, future-order availability, capacity data, and timing settings.

The AI may phrase the result naturally. It may not invent a wait time or claim the store is open/closed without checking the shared schedule.

## After-hours AI phone answering

The AI phone line can remain available when the restaurant is closed.

When the store is closed, the AI should:

1. explain that the restaurant is currently closed;
2. resolve the next available ordering time from configured business hours and exceptions;
3. offer to take a future order for the next available time or another valid future time;
4. continue normal menu/modifier/payment validation for that future order;
5. never send a future order to production as an ASAP order by accident.

Suggested conversational style:

> "We're closed right now, but I can still take your order for tomorrow or another available time."

If the restaurant is closed before opening later the same day, the AI can offer the later same-day opening instead of automatically pushing the customer to tomorrow.

Business hours must support regular weekly hours plus date-specific exceptions for holidays, special closings, and custom hours.

## ASAP timing

Corner Deli working guest-facing timing:

- pickup: **about 30 minutes**
- delivery and no-contact delivery: **typically 40 to 45 minutes**, followed by the natural reassurance **"but we'll get it to you as fast as we can"**
- curbside uses the pickup preparation timing unless configured differently

These values are settings rather than prompt text hidden inside the AI.

### Busy periods

The order engine can use rolling order volume/capacity to switch from the normal quote to a busy quote.

Working busy quote:

> "We're saying about an hour right now, but we'll get it to you as fast as we can."

The number of orders that triggers the busy quote and the rolling time window are deliberately configurable. No production threshold is assumed until management chooses it from observed store volume.

## ASAP or future

Every applicable ordering channel should let the customer choose:

- **ASAP**
- **Future time**

Future orders are validated against:

- business hours and date exceptions
- enabled fulfillment types
- maximum future-order horizon
- fulfillment capacity windows
- menu/item availability for that time where applicable

An unavailable requested time should return valid nearby alternatives rather than silently moving the order.

## Kitchen ticket visibility

Every kitchen ticket must make timing obvious.

ASAP example:

```text
*** ASAP PICKUP ***
QUOTE: 30 MIN
```

Delivery example:

```text
*** ASAP DELIVERY ***
QUOTE: 40-45 MIN
```

Future example:

```text
*** FUTURE PICKUP ***
FOR: Aug 12, 5:30 PM
```

The timing label is snapshotted onto the order/ticket so later settings changes do not rewrite the instructions staff originally received.

Future-order kitchen release timing can be configured separately from the visible requested time. Regardless of whether the ticket is released immediately or closer to prep time, the printed ticket must prominently state that it is a future order and the requested fulfillment time.

## Stored order timing

The order model supports:

- timing mode: `asap` or `future`
- requested/scheduled fulfillment time
- promised time
- quoted lead-time range
- guest-facing quote snapshot
- kitchen timing label snapshot
- optional kitchen release time

This allows post-order review to answer exactly what wait time was quoted and what the kitchen was told.
