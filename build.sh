#!/usr/bin/env bash
# 手工构建（不依赖 Gradle）：aapt2 + javac + d8 + zipalign + apksigner
# 用法：ANDROID_HOME=/path/to/sdk bash build.sh
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BT=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)
PLAT=$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1)
[ -n "$BT" ] || { echo "找不到 build-tools，请设置 ANDROID_HOME"; exit 1; }
[ -n "$PLAT" ] || { echo "找不到 platforms/android-*"; exit 1; }
echo "build-tools: $BT"
echo "platform   : $PLAT"

rm -rf build && mkdir -p build/res build/obj build/dex build/gen
"$BT/aapt2" compile --dir app/src/main/res -o build/res.zip
"$BT/aapt2" link -o build/base.apk \
  -I "$PLAT/android.jar" \
  --manifest app/src/main/AndroidManifest.xml \
  -A app/src/main/assets \
  --java build/gen \
  build/res.zip

javac -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$PLAT/android.jar" \
  -d build/obj \
  $(find app/src/main/java build/gen -name '*.java')

"$BT/d8" --lib "$PLAT/android.jar" --min-api 23 --output build/dex \
  $(find build/obj -name '*.class')

cp build/base.apk build/unsigned.apk
(cd build && zip -q -j unsigned.apk dex/classes.dex)

"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk

KS=build/debug.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out RouParser.apk build/aligned.apk
echo "✅ 产物: $(pwd)/RouParser.apk"
