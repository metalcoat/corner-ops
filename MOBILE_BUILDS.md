# Corner Deli POS mobile builds

Both native projects load the secured POS from `https://dev.ordercornerdeli.com/pos/deli`. Override it for a build with `CORNER_OPS_MOBILE_URL`.

## Android APK

Run `npm run mobile:android`. The development APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. It is signed with the local Android debug key and can be sideloaded directly. Use a backed-up, long-lived release keystore before distributing production updates.

## iPad / SideStore IPA

On a Mac with Xcode:

1. Run `npm ci` and `npm run mobile:ios`.
2. Run `npx cap open ios`.
3. Select the `App` target and a free Personal Team signing identity.
4. Archive/export the app or build it for the connected iPad.
5. Install the resulting IPA through SideStore and keep SideStore refresh enabled before the seven-day certificate expires.

The iPad should also keep the POS PWA installed as a non-expiring fallback.

## Security

The native shell does not contain employee credentials or payment secrets. It uses the existing POS IP approval, employee PIN session, Helcim server integration, and printer routing.
