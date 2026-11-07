#!/usr/bin/env bash
# Container side of `supplier-prices-sync.sh --signin <site>`: a virtual screen with
# the browser on it, shared as a web page (noVNC) on port 6080 for as long as the
# sign-in takes. VNC itself only listens inside the container; the page needs the
# one-time password in VNC_PASSWORD.
set -Eeuo pipefail

: "${VNC_PASSWORD:?VNC_PASSWORD is required}"
export DISPLAY=:99

Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 50); do [[ -e /tmp/.X11-unix/X99 ]] && break; sleep 0.1; done

pass="$(mktemp)"
x11vnc -storepasswd "$VNC_PASSWORD" "$pass" >/dev/null 2>&1
x11vnc -display :99 -rfbport 5900 -localhost -rfbauth "$pass" -forever -shared -quiet -bg -o /dev/null >/dev/null 2>&1
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

node /scraper/signin.mjs "$@"
