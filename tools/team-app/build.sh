#!/bin/sh
# Builds the signed Corner Deli employee app APK (tools/team-app) with Gradle inside a throwaway
# eclipse-temurin:17-jdk container, nothing to install on the server and no sudo.
#   Android SDK: ~/.local/share/android-sdk (platforms;android-36, build-tools;36.0.0; see README)
#   Gradle:      8.14.3 from ~/.gradle (downloaded on first use)
#   Signing key: ~/.config/corner-ops/team-app.jks + team-app.pass (made on first run; never commit;
#                every update must be signed with the same key, or it won't install over the old app and
#                the SHA-256 in public/.well-known/assetlinks.json stops matching)
# Output: tools/team-app/build/corner-deli-team.apk.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SDK=${ANDROID_SDK:-$HOME/.local/share/android-sdk}
KEYDIR=${TEAM_APP_KEY_DIR:-$HOME/.config/corner-ops}
GRADLE_HOME_DIR=${GRADLE_USER_HOME:-$HOME/.gradle}
GRADLE_VERSION=8.14.3
mkdir -p "$HERE/build" "$KEYDIR" "$GRADLE_HOME_DIR"
[ -f "$KEYDIR/team-app.pass" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$KEYDIR/team-app.pass")
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GRADLE_USER_HOME=/gradle -e ANDROID_HOME=/sdk \
  -v "$SDK:/sdk" -v "$HERE:/app" -v "$KEYDIR:/keys" -v "$GRADLE_HOME_DIR:/gradle" -w /app eclipse-temurin:17-jdk sh -euc '
  PASS=$(cat /keys/team-app.pass)
  [ -f /keys/team-app.jks ] || keytool -genkeypair -keystore /keys/team-app.jks -storepass "$PASS" -keypass "$PASS" \
    -alias team-app -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Corner Deli Team, O=Corner Deli, L=Ogdensburg, ST=NY, C=US" >/dev/null
  umask 077
  printf "storeFile=/keys/team-app.jks\nstorePassword=%s\nkeyAlias=team-app\nkeyPassword=%s\n" "$PASS" "$PASS" > /tmp/signing.properties
  GRADLE=$(ls -d /gradle/wrapper/dists/gradle-'"$GRADLE_VERSION"'-*/*/gradle-'"$GRADLE_VERSION"'/bin/gradle 2>/dev/null | head -1 || true)
  if [ -z "$GRADLE" ]; then
    mkdir -p /gradle/car-tablet-dist && cd /gradle/car-tablet-dist
    [ -d gradle-'"$GRADLE_VERSION"' ] || { curl -fsSLo g.zip https://services.gradle.org/distributions/gradle-'"$GRADLE_VERSION"'-bin.zip && jar xf g.zip && rm g.zip && chmod +x gradle-'"$GRADLE_VERSION"'/bin/gradle; }
    GRADLE=/gradle/car-tablet-dist/gradle-'"$GRADLE_VERSION"'/bin/gradle; cd /app
  fi
  printf "sdk.dir=/sdk\n" > local.properties
  TEAM_APP_SIGNING=/tmp/signing.properties "$GRADLE" --no-daemon --console=plain -q assembleRelease
  cp app/build/outputs/apk/release/app-release.apk build/corner-deli-team.apk
  /sdk/build-tools/36.0.0/apksigner verify --print-certs build/corner-deli-team.apk | head -3
  keytool -list -keystore /keys/team-app.jks -storepass "$PASS" -alias team-app -v | grep "SHA256:"
'
echo "Built $HERE/build/corner-deli-team.apk"
