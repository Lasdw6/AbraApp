#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/abra-teleport/resources/Runtime/node/bin:$HOME/.local/bin:$PATH"
export ABRA_TELEPORT_DESKTOP=1
export ABRA_TELEPORT_BROWSER_SOURCE=managed
unset ELECTRON_RUN_AS_NODE
cd "$HOME"
exec /opt/abra-teleport/abra-teleport "$@"
