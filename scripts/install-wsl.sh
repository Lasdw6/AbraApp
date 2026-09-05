#!/usr/bin/env bash
set -euo pipefail
SOURCE="${1:?Pass the extracted Windows setup directory}"
[[ "$(uname -m)" == x86_64 ]] || { echo 'This preview requires x64 WSL.' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Run Ubuntu as your regular Linux user, not root. Finish Ubuntu user setup first.' >&2; exit 1; }
# Ubuntu 24.04 is the tested dependency set for this setup.
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo 'Use the Ubuntu-24.04 WSL distribution for this preview.' >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo 'Installing desktop dependencies in Ubuntu. Enter your Ubuntu password if sudo asks.'
sudo apt-get update
sudo apt-get install -y ca-certificates curl libnss3 libgtk-3-0t64 libgbm1 libasound2t64 libxtst6 libxss1 xdg-utils dbus-x11 fonts-liberation fonts-dejavu-core
if ! command -v google-chrome >/dev/null; then
  curl --fail --location --proto '=https' --proto-redir '=https' \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$WORK/chrome.deb"
  chmod 755 "$WORK"
  chmod 644 "$WORK/chrome.deb"
  sudo apt-get install -y "$WORK/chrome.deb"
fi
mkdir "$WORK/app"
tar -xzf "$SOURCE/app.tar.gz" --no-same-owner -C "$WORK/app"
[[ -x "$WORK/app/abra-teleport" && -x "$WORK/app/resources/Runtime/abra" && -x "$WORK/app/resources/Runtime/node/bin/node" ]] || {
  echo 'The application archive is incomplete.' >&2; exit 1;
}
# Install read-only application files as root so Chromium's sandbox helper is safe.
sudo mkdir -p /opt/abra-teleport
sudo cp -R "$WORK/app/." /opt/abra-teleport/
sudo cp "$SOURCE/launch-wsl.sh" /opt/abra-teleport/launch-wsl.sh
sudo chown -R root:root /opt/abra-teleport
sudo chmod -R go-w /opt/abra-teleport
sudo chmod 755 /opt/abra-teleport/launch-wsl.sh
sudo chmod 4755 /opt/abra-teleport/chrome-sandbox
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/bin"
cat > "$HOME/.local/share/applications/abra-teleport.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Abra Teleport
Exec=/opt/abra-teleport/launch-wsl.sh
Terminal=false
Categories=Development;
DESKTOP
cat > "$HOME/.local/bin/abra-teleport" <<'CLI'
#!/usr/bin/env bash
export PATH="/opt/abra-teleport/resources/Runtime/node/bin:$PATH"
export ABRA_BIN=/opt/abra-teleport/resources/Runtime/abra
export ABRA_BROWSER_ADAPTER=/opt/abra-teleport/resources/Runtime/browser-session
export ABRA_OBSERVER=/opt/abra-teleport/resources/Runtime/observer.py
exec node /opt/abra-teleport/resources/Runtime/wrapper/bin/abra-teleport.js "$@"
CLI
chmod 755 "$HOME/.local/bin/abra-teleport"
"$HOME/.local/bin/abra-teleport" doctor
echo 'Installed Abra Teleport. Your files and pairing state stay in your Linux home.'
