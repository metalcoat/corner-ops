#!/bin/sh
# Builds the Corner Deli display app (tools/display-app) into corner-deli-display.apk without Gradle:
# javac + d8 + aapt2 in a throwaway JDK container, using the Android SDK in ~/.local/share/android-sdk
# (platforms;android-30, build-tools;34.0.0 — see README.md). Signs with the key in
# ~/.config/corner-ops/display-app.jks (never commit it; every update must use the same key).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SDK=${ANDROID_SDK:-/home/chris/.local/share/android-sdk}
KEYDIR=${DISPLAY_KEY_DIR:-/home/chris/.config/corner-ops}
OUT=${1:-$HERE/build/corner-deli-display.apk}
mkdir -p "$HERE/build" "$KEYDIR"
[ -f "$KEYDIR/display-app.pass" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$KEYDIR/display-app.pass")
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$SDK:/sdk:ro" -v "$HERE:/app" -v "$KEYDIR:/keys" -w /app eclipse-temurin:17-jdk sh -euc '
  BT=/sdk/build-tools/34.0.0; JAR=/sdk/platforms/android-30/android.jar; PASS=$(cat /keys/display-app.pass)
  rm -rf build/tmp && mkdir -p build/tmp/classes build/tmp/dex build/tmp/res
  [ -f /keys/display-app.jks ] || keytool -genkeypair -keystore /keys/display-app.jks -storepass "$PASS" -keypass "$PASS" \
    -alias display -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Corner Deli Display, O=Corner Deli, L=Ogdensburg, ST=NY, C=US" >/dev/null
  $BT/aapt2 compile --dir res -o build/tmp/res/res.zip
  $BT/aapt2 link -o build/tmp/unsigned.apk -I $JAR --manifest AndroidManifest.xml build/tmp/res/res.zip --java build/tmp/gen
  javac -source 8 -target 8 -Xlint:-options -bootclasspath $JAR -classpath $JAR:$BT/core-lambda-stubs.jar -d build/tmp/classes $(find src build/tmp/gen -name "*.java")
  $BT/d8 --release --min-api 25 --lib $JAR --output build/tmp/dex $(find build/tmp/classes -name "*.class")
  (cd build/tmp/dex && cp ../unsigned.apk ../with-dex.apk && jar uf ../with-dex.apk classes.dex)
  $BT/zipalign -f -p 4 build/tmp/with-dex.apk build/tmp/aligned.apk
  $BT/apksigner sign --ks /keys/display-app.jks --ks-pass "pass:$PASS" --ks-key-alias display --out build/corner-deli-display.apk build/tmp/aligned.apk
  rm -rf build/tmp
'
[ "$OUT" = "$HERE/build/corner-deli-display.apk" ] || cp "$HERE/build/corner-deli-display.apk" "$OUT"
echo "Built $OUT"
