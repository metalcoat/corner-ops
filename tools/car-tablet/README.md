# Corner Ops car tablet (delivery car)

A dedicated Android tablet mounted in the delivery car (rugged LTE, Android 10+; built for 13–15, e.g. Galaxy Tab
Active5). It runs nothing but this app:

- **Always tracking.** A foreground service records GPS about every 5 s while moving (once a minute when parked),
  keeps the points in an on-tablet queue (SQLite) and uploads them in batches; after a dead zone the backlog goes up
  by itself. Fused location when Google Play services is there, otherwise the GPS/network providers.
- **Deliveries.** The driver signs in with their POS PIN (or, with nobody signed in, the tablet works for the only
  Driver on the clock). Big buttons: Navigate (Google Maps), Picked up · leaving, Arrived, Delivered, Call customer,
  Cabin photo, Road photo. The tablet uses the same delivery flow as the driver phone page, so the POS dispatch map,
  store dashboard and customer tracking link all see it.
- **Photos.** Front camera = cabin, rear camera = road (through the windshield). Taken without touching the screen
  for "snap now" requests from the POS and when the driver taps Delivered (that road photo is also the delivery's
  proof photo; no-contact orders need it before they can be marked delivered). Queued offline. **Never records
  audio** (the app doesn't even have the microphone permission).
- **Kiosk.** As device owner the app is the home screen, runs in lock task mode (only this app, Google Maps and the
  dialer can open), grants its own permissions, keeps the screen on while plugged in, and can't be force-stopped.
- **Self-starting.** Starts on boot (also before unlock), restarts itself if killed (sticky service + 10-minute
  watchdog alarm), asks once for the battery-optimization exemption.
- **Status.** Heartbeat every 30 s: battery, charging, network, signal, app version, upload queue. The POS shows
  online/offline.

Server side: `src/lib/car-tablet.ts`, routes under `src/app/api/car-tablet/` (tablet, bearer token) and
`src/app/api/ordering/car-tablets/` (POS), migration `db/migrations/0027_car_tablets.sql`. See
`docs/PROCESS-MAP.md` §8c.

## On the POS

**POS › Settings › Car tablet** (managers): Pair car tablet (code + QR), Rename, Pair again, Unpair, Snap cabin /
road / both, battery/network/GPS/driver/app version, latest photos (click for full size and map).
The store dashboard shows a status strip for each tablet and the car on the live map. Delivery orders in Order
Center show their car photos (managers get Snap buttons there too).

## Build

```sh
tools/car-tablet/build.sh          # unit tests + signed release APK → tools/car-tablet/build/corner-ops-car-tablet.apk
tools/car-tablet/publish-dev.sh    # → https://dev.ordercornerdeli.com/downloads/corner-ops-car-tablet.apk
```

`build.sh` runs Gradle 8.14.3 in the `eclipse-temurin:17-jdk` Docker image (no JDK on the server, no sudo), with the
Android SDK in `~/.local/share/android-sdk` (`platforms;android-36`, `build-tools;36.0.0`, `platform-tools`; install
more with `cmdline-tools/latest/bin/sdkmanager` inside the same image). First build downloads the libraries into
`~/.gradle`.

**Signing key:** `~/.config/corner-ops/car-tablet.jks`, password in `car-tablet.pass` next to it (made by the first
build). Never commit it; back it up with the other server keys. An update signed with a different key will not
install over the installed app (you'd have to uninstall, which as device owner means a factory reset).

**Updates:** raise `versionCode` (and `versionName`) in `app/build.gradle.kts`, then build and publish. The tablet
checks `/api/car-tablet/app` every 6 hours and shows "update … ready" in its status bar; install it from the staff
menu (silent when the app is device owner).

## Provisioning a tablet (kiosk / device owner)

Android only lets an app become device owner on a tablet with **no accounts** on it, so start from a factory reset.

1. **Reset:** Settings › General management › Reset › Factory data reset. Put the LTE SIM in.
2. **Setup wizard:** pick language, connect to Wi-Fi or mobile data, and **skip every account** (Google and Samsung).
   Skip/decline optional apps. Finish setup.
3. **Developer options:** Settings › About tablet › Software information › tap *Build number* 7 times. Then
   Settings › Developer options › turn on *USB debugging*.
4. **Connect** the tablet by USB to the store server (or any computer with adb) and accept the "Allow USB debugging"
   prompt on the tablet. On the store server: `ADB=~/.local/share/android-sdk/platform-tools/adb`.
5. **Install:**
   ```sh
   curl -fo /tmp/car.apk https://dev.ordercornerdeli.com/downloads/corner-ops-car-tablet.apk
   $ADB install -r /tmp/car.apk
   ```
6. **Make it device owner:**
   ```sh
   $ADB shell dpm set-device-owner com.cornerdeli.cartablet/.AdminReceiver
   ```
   It must answer `Success: Device owner set to package ...`. If it says there are accounts or users on the device,
   go back to step 1 (some Samsung setups add a Samsung account; remove it in Settings › Accounts or reset).
7. **Start it:**
   ```sh
   $ADB shell am start -n com.cornerdeli.cartablet/.MainActivity
   ```
   The app grants itself location (incl. background) and camera, becomes the home screen, and asks once to ignore
   battery optimization — tap **Allow**. (If Android still shows permission prompts, allow them; for location pick
   **Allow all the time**.) Then it locks into kiosk mode.
8. **Pair:** on the POS, Settings › Car tablet › *Pair car tablet* (give it a name). On the tablet type the server
   (`https://dev.ordercornerdeli.com` is filled in) and the 8-character code (works once, 15 minutes), and choose the
   **staff exit PIN** (4–8 digits; keep it with the manager notes). Scanning the QR with another app also works
   when the tablet isn't locked yet.
9. **Samsung battery settings** (belt and braces): staff menu › Android settings › Battery › Background usage limits
   › *Never sleeping apps* › add Corner Ops Car. Leave *Put unused apps to sleep* off.
10. **Lock it down:** staff menu › Android settings › Developer options › turn off USB debugging (and Developer
    options). Staff menu › *Back to kiosk mode*.
11. **Check:** reboot the tablet. It should come straight back into the app; within a minute the POS settings page
    shows it **Online** with battery and a GPS fix. Press *Snap both* on the POS and two photos should appear within
    a few seconds.
12. **Mount:** screen facing the driver, so the rear camera looks out the windshield (road) and the front camera at
    the cabin. Keep it on car power (it stays awake while plugged in).

Without device owner (e.g. testing on a phone) the app still works: it asks for each permission, and you can
turn on Android's screen pinning, but nothing stops someone from leaving the app.

### Staff menu

Hold the green **CORNER DELI CAR** title for 3 seconds, enter the staff exit PIN:
leave kiosk mode / back to kiosk mode, Android settings, install update, check for update, unpair this tablet,
**remove device owner** (hands the tablet back as a normal device; making it a kiosk again needs a factory reset).

### Unpairing / lost tablet

POS › Settings › Car tablet › **Unpair** revokes its token immediately; the tablet drops back to its pairing screen
the next time it talks to the server. Pair again to give it a new token.

## Notes

- Data use: GPS uploads are a few KB every 10 s while driving; photos are ~0.3–1 MB each.
- Cabin photos show the driver. Tell drivers the car has an inward camera that can take stills on request
  (no video, no audio), and when.
- Photos are files in the app's uploads volume (`car-tablet/<tablet>/<date>/`), so the nightly backup's uploads
  archive includes them. There is no automatic deletion yet.
- The app keeps its settings, queue and photos in Android's device-protected storage so it can run before the first
  unlock after a reboot (the kiosk has no lock screen).
