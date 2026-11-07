# Corner Deli display app (Fire TVs)

A tiny Android app that shows one web page full screen and nothing else: the menu boards
(`/pos/menu-board?tv=1..3`) and the greeter (`/pos/greeter/tv`). It replaced Fully Kiosk on 2026-10-22
because Fully made Fire OS show a "Microphone is on" icon over the menu.

- Plays sound and music without a tap, keeps the screen on, ignores the Back button.
- Opens itself when the TV starts (boot receiver).
- Takes the screen back about 4 seconds after anything else comes up (Home, an HDMI input, Live TV, another app) and
  when the TV wakes (KeeperService). Needs "display over other apps", granted once per TV:
  `adb shell appops set com.cornerdeli.display SYSTEM_ALERT_WINDOW allow`. For maintenance, turn it off with
  `adb shell am start -n com.cornerdeli.display/.MainActivity --ez keep false` (and `true` to turn it back on).
- If the page can't load (server or Wi-Fi down) it retries every 15 seconds.
- Asks for no microphone, camera or storage access.

The page address is sent once from the store server and remembered:

```sh
adb -s 192.168.6.231:5555 shell am start -n com.cornerdeli.display/.MainActivity -d 'http://192.168.1.237:3000/pos/menu-board?tv=3'
```

`tools/menu-tvs/menu-tv.sh` does this by itself whenever a TV isn't showing its page during store hours.

## Build and install

`./build.sh` builds `build/corner-deli-display.apk` (gitignored) without Gradle, in a throwaway
`eclipse-temurin:17-jdk` container, using the Android SDK in `~/.local/share/android-sdk`
(`platforms;android-30` and `build-tools;34.0.0`, installed with Google's command-line tools). It signs with
`~/.config/corner-ops/display-app.jks` (password in `display-app.pass` beside it). Never commit or lose that
key: an update signed with another key won't install over the old app.

```sh
tools/display-app/build.sh
adb -s <tv>:5555 install -r tools/display-app/build/corner-deli-display.apk
adb -s <tv>:5555 shell pm disable-user --user 0 de.ozerov.fully   # keep Fully from coming back on top
```

Raise `versionCode` in `AndroidManifest.xml` for each update.

## Greeter music (YouTube, no ads)

The greeter page asks the app (`window.CornerDeliTv`) to play the season's playlist from `src/lib/greeter-playlists.ts`.
The app plays it in a hidden second WebView running YouTube's TV site (`youtube.com/tv`, identifying as the Fire TV
YouTube app), signed in to the store's YouTube Premium account, so no ads play. It pauses for each spoken welcome.

Pairing was done once on 2026-10-22. To pair again (new account, or signed out):

```sh
adb -s 192.168.6.83:5555 shell am start -n com.cornerdeli.display/.MainActivity --ez music_setup true
```

YouTube's sign-in screen comes up on the TV; choose "Sign in with your phone" and enter the code at yt.be/activate,
pick the account, then run the same command with `--ez music_setup false`. The app turns on WebView debugging, so
`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` lets the server look at either page.
