#!/usr/bin/env bash
# Release packaging fills in the archive URL and digest.
set -euo pipefail
TICKET="${1:-}"
[[ "$TICKET" == abra-pair/1/* || "$TICKET" =~ ^ABRA-([A-Z2-7]{8}|[A-Za-z0-9_-]{22})$ ]] || { echo 'Run the connection command from the app.' >&2; exit 1; }
CLI="$(command -v abra-teleport || true)"
if [[ -z "$CLI" && -x "${ABRA_TELEPORT_BIN_DIR:-$HOME/.local/bin}/abra-teleport" ]]; then
  CLI="${ABRA_TELEPORT_BIN_DIR:-$HOME/.local/bin}/abra-teleport"
fi
REQUIRED_HELP='agent connect'
[[ "$TICKET" == ABRA-* ]] && REQUIRED_HELP='ticket-or-code'
[[ "$TICKET" =~ ^ABRA-[A-Z2-7]{8}$ ]] && REQUIRED_HELP='8-character pairing codes'
CLI_HELP=""
if [[ -n "$CLI" ]]; then CLI_HELP="$("$CLI" --help 2>/dev/null || true)"; fi
if [[ "$CLI_HELP" != *"$REQUIRED_HELP"* || "$CLI_HELP" != *'abra-teleport skill'* ]]; then
  ARCHIVE_URL='@ARCHIVE_URL@'
  EXPECTED='@ARCHIVE_SHA256@'
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
