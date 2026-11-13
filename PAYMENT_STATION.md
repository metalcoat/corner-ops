# Corner Deli payment station

Corner Deli has two payment registers, each with its own cash drawer: the front register (**Upfront**) with the Dejavoo card terminal, and the back register (**Back pos 1**), which keys cards in. Any other tablets take orders only.

1. In **POS → Settings → Printers & devices**, add the receipt printer attached to each cash drawer.
2. Add a keyboard-wedge magnetic-stripe reader as the gift-card reader. Existing gift cards work by Track 1, Track 2, or their printed number; no PIN is required.
3. Under **Registers**, set each register that takes money to **Yes — payment register** and give it its receipt printer (its till and cash drawer), gift-card swiper, and **Card terminal** (or *None (key in cards)*). Any number of registers can take payments.
4. Add each other tablet as an order-taking register (**No — takes orders**). **Sends checks to** picks the payment register its checks go to; left on the default, they go to the only payment register, or to every payment register when there are several. Then choose **Use on this tablet** on the matching device.
5. Order-taking tablets send unpaid checks to **Payments**. Only a payment register can record card-present, gift-card, or till-cash tenders, and its cash goes into its own till.

The cash drawer plugs into the supported network receipt printer's drawer port. A till cash sale or the manager-only **TEST DRAWER** action sends the ESC/POS drawer pulse through that printer. Drawer sales and refunds are recorded in the register-session cash ledger.

## Dharma / MX Merchant

All card payments (keyed, online, and the terminal) go through Dharma / MX Merchant; Helcim is no longer used. The server expects `MX_MERCHANT_ID`, `MX_CONSUMER_KEY`, and `MX_CONSUMER_SECRET` (no business ID: no MX call uses one), with `MX_ENVIRONMENT=production` for the live account (anything else uses the sandbox). Set `MX_TERMINAL_API_ENABLED=true` only after the selected tap/chip/swipe terminal has been certified for the account.

### Card terminal (Dejavoo through MX)

At the payment station the customer pays first and tips after, on one charge:

1. When the cashier opens **CHECKOUT**, the POS sends an *authorization* for the balance to the terminal through MX's Terminal API. The customer can tap, insert, or swipe right away; nobody has to press CREDIT. With split checks, each check goes to the terminal when the cashier presses CREDIT on it.
2. When MX approves the card, the POS shows the tip choices (15/18/20%, custom, or no tip).
3. The POS *completes* the authorization for balance + tip ([MX: auth then completion with tip](https://developer.mxmerchant.com/docs/making-an-adjustment)). The order is marked paid, and the tip added, only once MX approves that completion.

The amount and card on the order always come from MX. Refunds and voids use the same MX path as keyed payments; voiding a terminal charge also releases its authorization, because MX otherwise puts the hold back on the card.

Setup when the terminal arrives:

1. Dharma registers the Dejavoo in MX Merchant (Settings → Terminals, POS provider **Dejavoo**, using the SPIn RegisterID and AuthKey from the Dejavoo portal). Ask Dharma to **turn off the tip screen on the terminal**, because the POS asks for the tip after the card.
2. Run `npm run mx:terminal-check` to list the terminals MX knows about, or press **TEST PROVIDER** in POS → Settings → Hardware. The terminal ID is the long GUID, not the short numeric ID.
3. Run `npm run mx:terminal-check -- --sale <GUID>` against the sandbox. It runs the POS flow for $0.01: authorizes, waits for a test card, completes with a $0.01 tip, and voids it. Until a physical terminal is connected, MX answers "The terminal is not connected."
4. In **Printers & devices → Card terminals & swipers**, press **+ Add card terminal**, name it, pick it with **Find my terminals** (or paste the GUID into **MX terminal ID**), and save. Then edit the front payment register and choose it as its **Card terminal**.
5. Set `MX_TERMINAL_API_ENABLED=true`. Until then, the payment station keys cards in as before.

Things to know at the counter:

- **Paying with cash or another card instead:** press the red X on the terminal, then **STOP WAITING**. MX cannot cancel a sale on a Dejavoo, so the POS will not take another payment on the order while the terminal could still charge the card (until MX reports it cancelled, or for 3 minutes).
- **Customer taps anyway after STOP WAITING:** the next payment attempt on that order finds the approved card. Another terminal charge goes to the tip step; cash or a keyed card charges the approved card with no tip and tells the cashier the balance changed.
- **Nobody answers the tip question:** the scheduled maintenance job charges the card with no tip after 10 minutes, so the hold always ends up on the order.
- **Customer changes their mind after the card is approved:** **RELEASE CARD** voids the hold without charging.
- **Order changed after the card was approved:** the POS charges the current balance plus tip, never more than was approved. If nothing is left to pay (for example, it was paid another way), the hold is released instead. When less than the hold is charged, the bank drops the unused part of the hold when the batch settles.
- **Problem charges:** if MX approves a different amount than the POS sent, or the POS cannot add the charge to the order, it does not record it. It lists it under **Card terminal charges to review** in Hardware settings with the MX payment ID, and the order takes no other payment until a manager marks it resolved.
- **Customer display:** a terminal sale does not use the customer display for the tip; the tip is asked on the POS after the card. Other stations ask for tips on the customer display only when the station has **customer display** turned on.

Tests:

- `npm run test:mx-terminal` checks the payment logic against a local stand-in for MX (`scripts/lib/mx-stand-in.ts`). It runs on the private dev database and rolls back its changes.
- `npm run build && npm run test:mx-terminal:e2e` drives the real POS screens in a browser. It starts its own app server on port 3057 against the stand-in. For the run, it gives the Corner Deli payment station a test terminal and switches the store's printers off, so a test payment cannot print in the store. Afterwards it deletes the test orders and their print jobs, then restores the printers and the station.

The Dharma payment terminal should be treated as a payment device, not as a raw gift-card reader. Use the inexpensive keyboard-wedge magnetic-stripe reader for the existing store gift cards unless Dharma explicitly confirms that its terminal can return unencrypted non-payment card data to this application.
