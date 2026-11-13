#!/bin/sh
# Puts the built car tablet APK on DEV for sideloading and self-update:
#   https://dev.ordercornerdeli.com/downloads/corner-ops-car-tablet.apk
# Copies it (and a small version file read by /api/car-tablet/app) into the dev app's uploads volume.
# Dev only: never point this at the production container.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
APK=${1:-$HERE/build/corner-ops-car-tablet.apk}
CONTAINER=corner-ops-app
SDK=${ANDROID_SDK:-$HOME/.local/share/android-sdk}
[ -f "$APK" ] || { echo "No APK at $APK; run build.sh first." >&2; exit 1; }
BADGING=$("$SDK/build-tools/36.0.0/aapt2" dump badging "$APK" | head -1)
CODE=$(echo "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")
NAME=$(echo "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '{"appId":"com.cornerdeli.cartablet","versionCode":%s,"versionName":"%s","sha256":"%s","publishedAt":"%s"}\n' \
  "$CODE" "$NAME" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP/car-tablet.json"
cp "$APK" "$TMP/CornerOpsCarTablet.apk"
chmod 644 "$TMP"/*
docker exec "$CONTAINER" mkdir -p /data/uploads/mobile-builds
docker cp "$TMP/CornerOpsCarTablet.apk" "$CONTAINER:/data/uploads/mobile-builds/CornerOpsCarTablet.apk"
docker cp "$TMP/car-tablet.json" "$CONTAINER:/data/uploads/mobile-builds/car-tablet.json"
echo "Published $NAME ($CODE) sha256 $SHA"
