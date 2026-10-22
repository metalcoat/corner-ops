#!/bin/sh
# Turn the greeter TV on or off over HDMI-CEC. Run from cron on the Pi (see README.md):
#   tv-power.sh on | wake | off | status
# "wake" turns the TV on and leaves it on its own Fire TV input (the greeter runs there now): it sends the
# remote's power-on key over HDMI instead of "Image View On", which would switch the TV to the Pi.
# The Pi registers as a playback device first, since that setting doesn't survive a reboot.
# "on" wakes the TV and switches it to the Pi's input; a retry covers a TV slow to wake.
set -u
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

cec-ctl --playback >/dev/null 2>&1

power() { cec-ctl --to 0 --give-device-power-status 2>/dev/null | sed -n 's/.*pwr-state: \([a-z-]*\).*/\1/p' | head -n1; }

case "${1:-}" in
  on)
    for attempt in 1 2 3; do
      cec-ctl --to 0 --image-view-on >/dev/null 2>&1
      sleep 8
      cec-ctl --active-source phys-addr="$(cec-ctl | sed -n 's/.*Physical Address *: //p')" >/dev/null 2>&1
      state=$(power)
      [ "$state" = "on" ] && break
    done
    log "on requested, TV reports: ${state:-no answer}"
    ;;
  wake)
    for attempt in 1 2 3; do
      cec-ctl --to 0 --user-control-pressed ui-cmd=power-on-function >/dev/null 2>&1
      cec-ctl --to 0 --user-control-released >/dev/null 2>&1
      sleep 8
      state=$(power)
      [ "$state" = "on" ] && break
    done
    log "wake requested, TV reports: ${state:-no answer}"
    ;;
  off)
    cec-ctl --to 0 --standby >/dev/null 2>&1
    sleep 5
    log "off requested, TV reports: $(power || true)"
    ;;
  status)
    power
    ;;
  *)
    echo "usage: $0 on|wake|off|status" >&2
    exit 2
    ;;
esac
