# Corner Deli employee app

The Android app for staff: a Trusted Web Activity named **Corner Deli** (package `com.cornerdeli.team`) that opens
`https://team.ordercornerdeli.com/employee` full screen in Chrome. There is no app code to speak of: everything staff
see is the employee hub, so hub changes reach the app without a new APK. Web push from the hub shows as this app's
notifications (`TeamDelegationService`).

Android only hides the URL bar once `https://team.ordercornerdeli.com/.well-known/assetlinks.json` lists this package
and the signing certificate's SHA-256 (`public/.well-known/assetlinks.json`). Until production serves it, the app
still works, with a URL bar.

## Build

```sh
tools/team-app/build.sh          # signed release APK → tools/team-app/build/corner-deli-team.apk
tools/team-app/publish-dev.sh    # → https://dev.ordercornerdeli.com/downloads/corner-deli-team.apk
```

Same setup as `tools/car-tablet`: Gradle in the `eclipse-temurin:17-jdk` Docker image, Android SDK in
`~/.local/share/android-sdk`. `node tools/team-app/icons.mjs` remakes the launcher icons from the store logo.

**Signing key:** `~/.config/corner-ops/team-app.jks`, password in `team-app.pass` next to it (made by the first build).
Never commit it. Back it up: an update signed with another key won't install over the app, and the fingerprint in
`assetlinks.json` would stop matching.

Raise `versionCode` in `app/build.gradle.kts` for each new APK.
