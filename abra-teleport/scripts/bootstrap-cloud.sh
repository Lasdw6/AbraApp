#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "bootstrap-cloud.sh must run as root" >&2
  exit 1
fi

PACKAGE=${1:-/tmp/abra-teleport-0.1.0.tgz}
ABRA_COMMIT=${ABRA_COMMIT:-511d0c7ac9c141a9825df60275fd0dc953cb1a74}
CODEX_VERSION=${CODEX_VERSION:-0.144.6}
SOURCE=/opt/abra-source
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

[[ -f "$PACKAGE" ]] || { echo "missing wrapper package: $PACKAGE" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# Some minimal Linux images expose systemd-resolved's loopback stub without a
# working resolver service. Fall back to public DNS when first-boot DNS fails.
if ! getent hosts archive.ubuntu.com >/dev/null 2>&1; then
  if [[ ! -f /etc/resolv.conf.abra-teleport-backup ]]; then
    cp -L /etc/resolv.conf /etc/resolv.conf.abra-teleport-backup
  fi
  unlink /etc/resolv.conf 2>/dev/null || true
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf
fi

apt-get update
apt-get install -y --no-install-recommends bubblewrap build-essential ca-certificates curl git gnupg perl pkg-config

if ! command -v npm >/dev/null || [[ $(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1) -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v google-chrome >/dev/null; then
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb
  apt-get install -y /tmp/google-chrome.deb
  rm -f /tmp/google-chrome.deb
fi

if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain 1.91.0
fi
export PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin

rm -rf "$SOURCE"
git clone --filter=blob:none https://github.com/Lasdw6/Abra.git "$SOURCE"
git -C "$SOURCE" checkout --detach "$ABRA_COMMIT"
CARGO_BUILD_JOBS=1 cargo build --manifest-path "$SOURCE/Cargo.toml" --release -p abra-cli -p cadabra
install -m 0755 "$SOURCE/target/release/abra" /usr/local/bin/abra
install -m 0755 "$SOURCE/target/release/cadabra" /usr/local/bin/cadabra
install -D -m 0755 "$SOURCE/adapters/firecracker/guest/observer.py" /usr/local/libexec/abra-observer
install -d -m 0700 /var/lib/abra/adapters
rm -rf /var/lib/abra/adapters/browser-session
cp -a "$SOURCE/adapters/browser-session" /var/lib/abra/adapters/browser-session

npm install --global --omit=dev --no-audit --no-fund "@openai/codex@$CODEX_VERSION" "$PACKAGE"

install -d -m 0700 /workspace/abra-teleport/current
install -m 0644 "$SCRIPT_DIR/../systemd/abra-observer.service" /etc/systemd/system/abra-observer.service

systemctl daemon-reload
systemctl enable --now abra-observer.service
rm -rf "$SOURCE" /root/.cargo/registry /root/.cargo/git
apt-get clean
rm -rf /var/lib/apt/lists/*

ABRA_BROWSER_ADAPTER=/var/lib/abra/adapters/browser-session abra-teleport setup
ABRA_BROWSER_ADAPTER=/var/lib/abra/adapters/browser-session abra-teleport doctor
