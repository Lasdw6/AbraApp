#!/usr/bin/env bash
# Release packaging fills in the archive URL and digest.
set -euo pipefail
TICKET="${1:-}"
[[ "$TICKET" == abra-pair/1/* ]] || { echo 'Run the connection command from the app.' >&2; exit 1; }
CLI="$(command -v abra-teleport || true)"
if [[ -z "$CLI" && -x "${ABRA_TELEPORT_BIN_DIR:-$HOME/.local/bin}/abra-teleport" ]]; then
  CLI="${ABRA_TELEPORT_BIN_DIR:-$HOME/.local/bin}/abra-teleport"
fi
if [[ -z "$CLI" ]] || ! "$CLI" --help | grep -q 'agent connect'; then
  ARCHIVE_URL='https://github.com/Lasdw6/AbraApp/releases/download/v0.3.0-rc.3/abra-teleport-agent.tar.gz'
  EXPECTED='a300d12737c2c5a410d167d7436f3f7a53015668bc0c492368f03c841ef01193'
  [[ "$ARCHIVE_URL" == https://* && "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo 'This installer has not been packaged for download.' >&2; exit 1; }
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  echo 'Installing the agent CLI…'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$ARCHIVE_URL" -o "$STAGE/agent.tar.gz"
  if command -v sha256sum >/dev/null; then
    ACTUAL="$(sha256sum "$STAGE/agent.tar.gz" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$STAGE/agent.tar.gz" | awk '{print $1}')"
  fi
  [[ "$ACTUAL" == "$EXPECTED" ]] || { echo 'Installer checksum mismatch.' >&2; exit 1; }
  tar -xzf "$STAGE/agent.tar.gz" -C "$STAGE"
  bash "$STAGE/abra-teleport/scripts/install-agent.sh"
  CLI="${ABRA_TELEPORT_BIN_DIR:-$HOME/.local/bin}/abra-teleport"
fi
echo 'Connecting to your laptop…'
"$CLI" agent connect "$TICKET"
