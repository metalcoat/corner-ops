# Corner Deli menu TVs

Three Hisense Fire TVs (43QD6QF, Fire OS 8.1) show `/pos/menu-board?tv=1..3` in Fully Kiosk Browser:
TV 1 `192.168.6.162`, TV 2 `192.168.6.247`, TV 3 `192.168.6.231`. The front-door greeter TV `192.168.6.83` (same model)
runs `/pos/greeter/tv` the same way and is handled by the same script. Each has developer options with ADB
debugging on, and has accepted the store server's adb key ("Always allow from this computer").

`menu-tv.sh` runs every 2 minutes from user `chris`'s crontab on the store server. Between 10:20 AM and
closing (9:35 PM Sunday–Thursday, 10:35 PM Friday–Saturday, Eastern) it wakes any TV that is off and
reopens the menu if something else is on screen. From closing until 10:20 it keeps them asleep, putting
back to sleep any TV that wakes up overnight (a Fire TV can wake itself).

```sh
*/2 * * * * /opt/corner-ops/runtime/tools/menu-tvs/menu-tv.sh >> /home/chris/.local/state/menu-tv.log 2>&1
```

`menu-tv.sh status` shows each TV; `menu-tv.sh on` / `off` does all three now. adb is Google's
platform-tools in `/home/chris/.local/share/android-platform-tools` (key in `~/.android/adbkey`; a new
key means pressing Allow on every TV again).

Setting up a new TV: turn on developer options (Settings › Device & Software, press **About** 7 times),
turn on ADB debugging, then from the server `adb connect <ip>:5555`, press Allow on the TV, and
`adb install` the Fully Kiosk APK (fully-kiosk.com blocks the server, so download it elsewhere).

## Extras turned off (2026-10-22)

Each TV has these switched off with `pm disable-user --user 0 <package>` (no root; undo with
`adb shell pm enable <package>`): Netflix `com.netflix.ninja`, Amazon Music/Photos `com.amazon.bueller.music`,
`com.amazon.bueller.photos`, shopping `com.amazon.shoptv.client`, games `com.amazon.gamehub`, the screensaver
`com.amazon.ftv.screensaver`, recommendations `com.amazon.media.recommendations`, and the two tutorials
`com.amazon.storm.lightning.tutorial`, `com.amazon.tmm.tutorial`. Fully Kiosk `de.ozerov.fully` is off too.
Never disable the launcher, settings, input or system UI packages: a TV that can't reach its home screen needs a
factory reset. Software updates are left on.
