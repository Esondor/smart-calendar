#!/bin/sh
# Builds "Smart Calendar Bar.app" (Apple Silicon and Intel). Needs only the Command Line Tools (xcode-select --install).
#   build.sh            install into /Applications
#   build.sh <folder>   install into that folder
#   build.sh --dmg      write the installer the server hands out: public/mac/SmartCalendarBar.dmg
set -e
cd "$(dirname "$0")"
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
APP="$OUT/Smart Calendar Bar.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
for a in arm64 x86_64; do swiftc -O -swift-version 5 -target "$a-apple-macos14" main.swift Panel.swift Settings.swift -o "$OUT/bin-$a"; done
lipo -create "$OUT/bin-arm64" "$OUT/bin-x86_64" -output "$APP/Contents/MacOS/SmartCalendarBar"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.smartcalendar.bar</string>
  <key>CFBundleName</key><string>Smart Calendar Bar</string>
  <key>CFBundleExecutable</key><string>SmartCalendarBar</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSSupportsSuddenTermination</key><true/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Smart Calendar connect link</string>
    <key>CFBundleURLSchemes</key><array><string>smartcalendar</string></array>
  </dict></array>
</dict></plist>
PLIST
ICON="$OUT/AppIcon.iconset"; mkdir -p "$ICON"
for s in 16 32 128 256 512; do
  sips -z $s $s ../../public/icon-512.png --out "$ICON/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d ../../public/icon-512.png --out "$ICON/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICON" -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP" 2>/dev/null

if [ "$1" = "--dmg" ]; then
  # drag-to-Applications disk image
  STAGE="$OUT/dmg"; mkdir -p "$STAGE" ../../public/mac
  mv "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
  rm -f ../../public/mac/SmartCalendarBar.dmg
  hdiutil create -quiet -volname "Smart Calendar Bar" -srcfolder "$STAGE" -fs HFS+ -format ULMO ../../public/mac/SmartCalendarBar.dmg
  echo "public/mac/SmartCalendarBar.dmg"
else
  DEST="${1:-/Applications}"
  OLD="$DEST/Smart Calendar Bar.app"; RUNNING=$(pgrep -f "$OLD/Contents/MacOS" || true)
  [ -n "$RUNNING" ] && kill $RUNNING
  rm -rf "$OLD" && mv "$APP" "$DEST/"
  [ -n "$RUNNING" ] && open "$OLD"          # it was running: start the new one
  echo "$OLD"
fi
