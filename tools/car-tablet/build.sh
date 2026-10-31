#!/bin/sh
# Builds the signed car tablet APK (tools/car-tablet) with Gradle inside a throwaway
# eclipse-temurin:17-jdk container — nothing to install on the server and no sudo.
#   Android SDK: ~/.local/share/android-sdk (platforms;android-36, build-tools;36.0.0; see README)
#   Gradle:      8.14.3 from ~/.gradle (downloaded on first use)
#   Signing key: ~/.config/corner-ops/car-tablet.jks + car-tablet.pass (made on first run; never commit;
#                every update must be signed with the same key or it won't install over the old app)
# Output: tools/car-tablet/build/corner-ops-car-tablet.apk; unit tests run first.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SDK=${ANDROID_SDK:-$HOME/.local/share/android-sdk}
KEYDIR=${CAR_TABLET_KEY_DIR:-$HOME/.config/corner-ops}
GRADLE_HOME_DIR=${GRADLE_USER_HOME:-$HOME/.gradle}
GRADLE_VERSION=8.14.3
mkdir -p "$HERE/build" "$KEYDIR" "$GRADLE_HOME_DIR"
[ -f "$KEYDIR/car-tablet.pass" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$KEYDIR/car-tablet.pass")
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GRADLE_USER_HOME=/gradle -e ANDROID_HOME=/sdk \
  -v "$SDK:/sdk" -v "$HERE:/app" -v "$KEYDIR:/keys" -v "$GRADLE_HOME_DIR:/gradle" -w /app eclipse-temurin:17-jdk sh -euc '
  PASS=$(cat /keys/car-tablet.pass)
  [ -f /keys/car-tablet.jks ] || keytool -genkeypair -keystore /keys/car-tablet.jks -storepass "$PASS" -keypass "$PASS" \
    -alias car-tablet -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Corner Ops Car Tablet, O=Corner Deli, L=Ogdensburg, ST=NY, C=US" >/dev/null
  umask 077
  printf "storeFile=/keys/car-tablet.jks\nstorePassword=%s\nkeyAlias=car-tablet\nkeyPassword=%s\n" "$PASS" "$PASS" > /tmp/signing.properties
  GRADLE=$(ls -d /gradle/wrapper/dists/gradle-'"$GRADLE_VERSION"'-*/*/gradle-'"$GRADLE_VERSION"'/bin/gradle 2>/dev/null | head -1 || true)
  if [ -z "$GRADLE" ]; then
    mkdir -p /gradle/car-tablet-dist && cd /gradle/car-tablet-dist
    [ -d gradle-'"$GRADLE_VERSION"' ] || { curl -fsSLo g.zip https://services.gradle.org/distributions/gradle-'"$GRADLE_VERSION"'-bin.zip && jar xf g.zip && rm g.zip && chmod +x gradle-'"$GRADLE_VERSION"'/bin/gradle; }
    GRADLE=/gradle/car-tablet-dist/gradle-'"$GRADLE_VERSION"'/bin/gradle; cd /app
  fi
  printf "sdk.dir=/sdk\n" > local.properties
  CAR_TABLET_SIGNING=/tmp/signing.properties "$GRADLE" --no-daemon --console=plain -q testReleaseUnitTest assembleRelease
  cp app/build/outputs/apk/release/app-release.apk build/corner-ops-car-tablet.apk
  /sdk/build-tools/36.0.0/apksigner verify --print-certs build/corner-ops-car-tablet.apk | head -3
'
echo "Built $HERE/build/corner-ops-car-tablet.apk"
