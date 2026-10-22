# Corner Deli menu TVs

Three Hisense Fire TVs (43QD6QF, Fire OS 8.1) show `/pos/menu-board?tv=1..3` in Fully Kiosk Browser:
TV 1 `192.168.6.162`, TV 2 `192.168.6.247`, TV 3 `192.168.6.231`. Each has developer options with ADB
debugging on, and has accepted the store server's adb key ("Always allow from this computer").

`menu-tv.sh` runs every 2 minutes from user `chris`'s crontab on the store server. Between 10:20 AM and
closing (9:35 PM Sunday–Thursday, 10:35 PM Friday–Saturday, Eastern) it wakes any TV that is off and
reopens the menu if something else is on screen. In the 15 minutes after closing it puts the TVs to
sleep; after that it leaves them alone until morning.

```sh
*/2 * * * * /opt/corner-ops/runtime/tools/menu-tvs/menu-tv.sh >> /home/chris/.local/state/menu-tv.log 2>&1
```

`menu-tv.sh status` shows each TV; `menu-tv.sh on` / `off` does all three now. adb is Google's
platform-tools in `/home/chris/.local/share/android-platform-tools` (key in `~/.android/adbkey`; a new
key means pressing Allow on every TV again).

Setting up a new TV: turn on developer options (Settings › Device & Software, press **About** 7 times),
turn on ADB debugging, then from the server `adb connect <ip>:5555`, press Allow on the TV, and
`adb install` the Fully Kiosk APK (fully-kiosk.com blocks the server, so download it elsewhere).
