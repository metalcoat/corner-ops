# Corner Deli payment station

The intended layout is one checkout device and any number of kitchen order-taking devices.

1. In **POS → Settings → Hardware**, add the receipt printer attached to the cash drawer.
2. Add a keyboard-wedge magnetic-stripe reader as the gift-card reader. Existing gift cards work by Track 1, Track 2, or their printed number; no PIN is required.
3. Add one active `payment` station and assign its receipt printer, gift-card reader, and (when Dharma enables it) payment terminal.
4. Add each kitchen device as an `order_taker` station, then choose **USE ON THIS DEVICE** on the matching device.
5. Kitchen devices send unpaid orders to **Payments**. Only the payment station can record card, gift-card, or till-cash tenders.

The cash drawer plugs into the supported network receipt printer's drawer port. A till cash sale or the manager-only **TEST DRAWER** action sends the ESC/POS drawer pulse through that printer. Drawer sales and refunds are recorded in the register-session cash ledger.

## Dharma / MX Merchant

Set `PAYMENT_PROVIDER=mx_merchant` only after Dharma supplies sandbox access and confirms terminal API/certification. The server expects `MX_MERCHANT_ID`, `MX_CONSUMER_KEY`, and `MX_CONSUMER_SECRET`. Set `MX_TERMINAL_API_ENABLED=true` only after the selected tap/chip/swipe terminal has been certified for the account.

### Card terminal (Dejavoo through MX)

The POS sends card sales to the terminal through MX's Terminal API. It signs in with the same consumer key and secret, sends the sale, and polls about every 2 seconds while the customer taps, inserts, or swipes. It then reads the approved payment back from MX by its replay ID, so the amount and card on the order come from MX. Refunds and voids use the same MX path as keyed payments.

Setup when the terminal arrives:

1. Dharma registers the Dejavoo in MX Merchant (Settings → Terminals, POS provider **Dejavoo**, using the SPIn RegisterID and AuthKey from the Dejavoo portal).
2. Run `npm run mx:terminal-check` to list the terminals MX knows about, or press **TEST PROVIDER** in POS → Settings → Hardware. The terminal ID is the long GUID, not the short numeric ID.
3. Run `npm run mx:terminal-check -- --sale <GUID>` against the sandbox. It sends a $0.01 sale, waits for a test card, and voids it. Until a physical terminal is connected, MX answers "The terminal is not connected."
4. In **Hardware**, add a payment terminal with connection **MX Merchant terminal (Dejavoo)** and that terminal ID, then assign it to the payment station.
5. Set `MX_TERMINAL_API_ENABLED=true`. Until then, the payment station keys cards in as before.

Things to know at the counter:

- MX cannot cancel a sale on a Dejavoo. **STOP WAITING** only stops the POS waiting; also press the red X on the terminal. If the customer taps anyway, the next card charge on that order finds the approval and records it instead of charging again.
- If MX approves a different amount than the POS sent, or the order was already paid another way, the POS does not record the charge. It shows the MX payment ID so a manager can refund or record it.
- `npm run test:mx-terminal` checks this flow against a local stand-in for MX. It runs on the private dev database and rolls back its changes.

The Dharma payment terminal should be treated as a payment device, not as a raw gift-card reader. Use the inexpensive keyboard-wedge magnetic-stripe reader for the existing store gift cards unless Dharma explicitly confirms that its terminal can return unencrypted non-payment card data to this application.
