#!/bin/sh
# Corner Deli menu TVs (Fire TVs running Fully Kiosk): keeps each TV on its menu during store
# hours and turns it on and off, over the network with adb. Run every 2 minutes from cron on
# the store server (see README.md). Store hours are Eastern time whatever the server clock is:
# on at 10:20 AM; off at 9:35 PM Sunday to Thursday and 10:35 PM Friday and Saturday.
#   menu-tv.sh          do whatever the time of day calls for
#   menu-tv.sh status   show each TV's power and what's on screen
#   menu-tv.sh on|off   wake or sleep every TV now (and show the menu)
set -u
ADB=${ADB:-/home/chris/.local/share/android-platform-tools/adb}
SERVER=${MENU_SERVER:-http://192.168.1.237:3000}
# address:TV number
TVS=${MENU_TVS:-"192.168.6.162:1 192.168.6.247:2 192.168.6.231:3"}
OPEN=1020

log() { echo "$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S') $*"; }

hhmm=$(TZ=America/New_York date +%H%M)
day=$(TZ=America/New_York date +%u) # 5 = Friday, 6 = Saturday
case "$day" in 5|6) CLOSE=2235 ;; *) CLOSE=2135 ;; esac

shell() { timeout 20 "$ADB" -s "$1:5555" shell "$2" 2>/dev/null; }
awake() { shell "$1" "dumpsys power" | grep -q 'mWakefulness=Awake'; }
showing_menu() { shell "$1" "dumpsys window" | grep 'mCurrentFocus' | grep -q 'de.ozerov.fully'; }
show_menu() { shell "$1" "am start -a android.intent.action.VIEW -d '$SERVER/pos/menu-board?tv=$2' de.ozerov.fully" >/dev/null; }

for entry in $TVS; do
  ip=${entry%:*}; tv=${entry#*:}
  timeout 10 "$ADB" connect "$ip:5555" >/dev/null 2>&1
  if ! shell "$ip" true; then log "TV $tv ($ip): not reachable"; continue; fi
  action=${1:-auto}
  if [ "$action" = auto ]; then
    # Only turn TVs off in the 15 minutes after closing, so a TV someone turns on later
    # (cleaning, a late event) is left alone until the next morning.
    if [ "$hhmm" -ge "$OPEN" ] && [ "$hhmm" -lt "$CLOSE" ]; then action=on
    elif [ "$hhmm" -ge "$CLOSE" ] && [ "$hhmm" -lt $((CLOSE + 15)) ]; then action=off
    else continue; fi
  fi
  case "$action" in
    on)
      if ! awake "$ip"; then shell "$ip" "input keyevent KEYCODE_WAKEUP"; sleep 6; log "TV $tv ($ip): woke"; fi
      if ! showing_menu "$ip"; then show_menu "$ip" "$tv"; log "TV $tv ($ip): opened the menu"; fi
      ;;
    off)
      if awake "$ip"; then shell "$ip" "input keyevent KEYCODE_SLEEP"; log "TV $tv ($ip): turned off"; fi
      ;;
    status)
      state=standby; awake "$ip" && state=on
      menu=other; showing_menu "$ip" && menu=menu
      echo "TV $tv ($ip): $state, showing $menu"
      ;;
    *) echo "usage: $0 [status|on|off]" >&2; exit 2 ;;
  esac
done
