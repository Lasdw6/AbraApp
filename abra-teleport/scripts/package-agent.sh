#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${ABRA_SOURCE:-$ROOT/../abra}"
npm --prefix "$ROOT" run build
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PACKAGE="$STAGE/abra-teleport"
mkdir -p "$PACKAGE/runtime/core-source" "$ROOT/dist"
for item in bin src adapters scripts package.json; do cp -R "$ROOT/build/$item" "$PACKAGE/"; done
cp "$CORE/adapters/sandbox/collector/observer.py" "$PACKAGE/runtime/observer.py"
cp -R "$CORE/adapters/browser-session" "$PACKAGE/runtime/browser-session"
cp -R "$CORE/adapters/lib" "$PACKAGE/runtime/lib"
cp "$CORE/Cargo.toml" "$CORE/Cargo.lock" "$PACKAGE/runtime/core-source/"
cp "$CORE/LICENSE-MIT" "$CORE/LICENSE-APACHE" "$PACKAGE/runtime/core-source/"
cp -R "$CORE/crates" "$PACKAGE/runtime/core-source/"
mkdir -p "$PACKAGE/runtime/core-source/adapters"
cp -R "$CORE/adapters/firecracker" "$PACKAGE/runtime/core-source/adapters/"
# Include the current platform's binary; other platforms build the pinned source.
PLATFORM="$(node -p 'process.platform + "-" + process.arch')"
mkdir -p "$PACKAGE/runtime/$PLATFORM"
cp "${ABRA_BIN:-$CORE/target/release/abra}" "$PACKAGE/runtime/$PLATFORM/abra"
for binary in "$ROOT"/dist/native/*/abra; do
  [[ -f "$binary" ]] || continue
  target="$(basename "$(dirname "$binary")")"
  case "$target" in linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;; *) echo "Unsupported binary platform: $target" >&2; exit 1;; esac
  mkdir -p "$PACKAGE/runtime/$target"
  cp "$binary" "$PACKAGE/runtime/$target/abra"
done
COPYFILE_DISABLE=1 tar --exclude='__pycache__' --exclude='*.pyc' --exclude='target' --exclude='.DS_Store' \
  -C "$STAGE" -czf "$ROOT/dist/abra-teleport-agent.tar.gz" abra-teleport
echo "$ROOT/dist/abra-teleport-agent.tar.gz"
node "$ROOT/build/scripts/package-connect.js"
