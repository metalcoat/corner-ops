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

The Dharma payment terminal should be treated as a payment device, not as a raw gift-card reader. Use the inexpensive keyboard-wedge magnetic-stripe reader for the existing store gift cards unless Dharma explicitly confirms that its terminal can return unencrypted non-payment card data to this application.
