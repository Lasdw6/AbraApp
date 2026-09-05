#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/dist/Abra Teleport.app"
MACOS="$APP/Contents/MacOS"
RESOURCES="$APP/Contents/Resources"
RUNTIME="$RESOURCES/Runtime"

rm -rf "$APP"
mkdir -p "$MACOS" "$RUNTIME/wrapper" "$RUNTIME/browser-session"
swiftc \
  -swift-version 5 \
  -parse-as-library \
  -O \
  -framework SwiftUI \
  -framework AppKit \
  "$ROOT/app/AbraTeleportApp.swift" \
  -o "$MACOS/AbraTeleport"
install -m 0644 "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"
install -m 0755 "$ROOT/../abra/target/debug/abra" "$RUNTIME/abra"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/adapters" "$ROOT/scripts" "$RUNTIME/wrapper/"
install -m 0644 "$ROOT/package.json" "$RUNTIME/wrapper/package.json"
cp -R \
  "$ROOT/../abra/adapters/browser-session/bin" \
  "$ROOT/../abra/adapters/browser-session/facade" \
  "$ROOT/../abra/adapters/browser-session/lib" \
  "$RUNTIME/browser-session/"
install -m 0644 \
  "$ROOT/../abra/adapters/browser-session/abra-adapter.json" \
  "$ROOT/../abra/adapters/browser-session/package.json" \
  "$RUNTIME/browser-session/"
codesign --force --deep --sign - "$APP"
plutil -lint "$APP/Contents/Info.plist"
codesign --verify --deep --strict "$APP"

echo "$APP"
