#!/bin/sh
# Puts the built Corner Deli employee app on DEV for sideloading:
#   https://dev.ordercornerdeli.com/downloads/corner-deli-team.apk
# Copies it into the dev app's uploads volume. Dev only: never point this at the production container.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
APK=${1:-$HERE/build/corner-deli-team.apk}
CONTAINER=corner-ops-app
[ -f "$APK" ] || { echo "No APK at $APK; run build.sh first." >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$APK" "$TMP/CornerDeliTeam.apk"
chmod 644 "$TMP"/*
docker exec "$CONTAINER" mkdir -p /data/uploads/mobile-builds
docker cp "$TMP/CornerDeliTeam.apk" "$CONTAINER:/data/uploads/mobile-builds/CornerDeliTeam.apk"
echo "Published sha256 $(sha256sum "$APK" | cut -d' ' -f1)"
