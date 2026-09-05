#!/usr/bin/env bash
# Run inside the extracted CLI package. All installation stays under this user's home.
set -euo pipefail
SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${ABRA_TELEPORT_INSTALL:-$HOME/.local/share/abra-teleport-cli}"
BIN_DIR="${ABRA_TELEPORT_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL" "$BIN_DIR"
if [[ "$SOURCE" != "$INSTALL" ]]; then
  for item in bin src adapters scripts runtime package.json; do cp -R "$SOURCE/$item" "$INSTALL/"; done
fi
# Retire files from older releases; user state lives outside this install directory.
rm -rf "$INSTALL/adapters/codex-session"
rm -f "$INSTALL/src/codex.js" "$INSTALL/src/codex.d.ts" "$INSTALL/src/app.js" "$INSTALL/src/app.d.ts"
case "$(uname -s)" in Linux) PLATFORM=linux;; Darwin) PLATFORM=darwin;; *) echo 'Linux or macOS is required.' >&2; exit 1;; esac
case "$(uname -m)" in x86_64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) echo 'x86_64 or arm64 is required.' >&2; exit 1;; esac
if command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  NODE="$(command -v node)"
else
  VERSION=v22.16.0
  NAME="node-$VERSION-$PLATFORM-$ARCH"
  DOWNLOAD="$(mktemp -d)"
  trap 'rm -rf "$DOWNLOAD"' EXIT
  curl --fail --location --proto '=https' "https://nodejs.org/dist/$VERSION/$NAME.tar.gz" -o "$DOWNLOAD/$NAME.tar.gz"
  curl --fail --location --proto '=https' "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" -o "$DOWNLOAD/SHASUMS256.txt"
  EXPECTED="$(awk -v name="$NAME.tar.gz" '$2 == name {print $1}' "$DOWNLOAD/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null; then
    ACTUAL="$(sha256sum "$DOWNLOAD/$NAME.tar.gz" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$DOWNLOAD/$NAME.tar.gz" | awk '{print $1}')"
  fi
  [[ -n "$EXPECTED" && "$EXPECTED" == "$ACTUAL" ]] || { echo 'Node download checksum mismatch.' >&2; exit 1; }
  mkdir -p "$INSTALL/runtime/node"
  tar -xzf "$DOWNLOAD/$NAME.tar.gz" --strip-components=1 -C "$INSTALL/runtime/node"
  NODE="$INSTALL/runtime/node/bin/node"
fi
BINARY="$INSTALL/runtime/$PLATFORM-$ARCH/abra"
if [[ ! -x "$BINARY" ]]; then
  if ! command -v rustup >/dev/null && [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
    curl --fail --location --proto '=https' https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.91.0
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup toolchain install 1.91.0 --profile minimal
  cargo +1.91.0 build --locked --release --manifest-path "$INSTALL/runtime/core-source/Cargo.toml" -p abra-cli
  mkdir -p "$(dirname "$BINARY")"
  cp "$INSTALL/runtime/core-source/target/release/abra" "$BINARY"
fi
chmod +x "$BINARY" "$INSTALL/bin/abra-teleport.js" "$INSTALL/adapters/teleport-agent/bin/adapter.js"
# Keep node on PATH for Abra's executable adapter entry points.
NODE_DIR="$(dirname "$NODE")"
printf '#!/usr/bin/env bash\nexport PATH=%q:"$PATH"\nexec %q %q "$@"\n' "$NODE_DIR" "$NODE" "$INSTALL/bin/abra-teleport.js" > "$BIN_DIR/abra-teleport"
chmod +x "$BIN_DIR/abra-teleport"
echo 'Installed. Add $HOME/.local/bin to PATH, then run the pairing command from Teleport.'
echo 'Browser handoffs require Chrome/Chromium.'
