#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox

install -d -m 0700 /run/abra-teleport

install -m 0644 /dev/stdin /etc/tmpfiles.d/abra-teleport.conf <<'EOF'
d /run/abra-teleport 0700 root root -
EOF

install -m 0644 /dev/stdin /etc/systemd/system/abra-teleport-display.service <<'EOF'
[Unit]
Description=Abra Teleport virtual display
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac +extension RANDR
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

install -m 0644 /dev/stdin /etc/systemd/system/abra-teleport-window-manager.service <<'EOF'
[Unit]
Description=Abra Teleport window manager
Requires=abra-teleport-display.service
After=abra-teleport-display.service

[Service]
Type=simple
Environment=DISPLAY=:99
ExecStart=/usr/bin/openbox
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

install -m 0644 /dev/stdin /etc/systemd/system/abra-teleport-vnc.service <<'EOF'
[Unit]
Description=Abra Teleport loopback VNC server
Requires=abra-teleport-display.service
After=abra-teleport-display.service

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -noxdamage -xkb
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

install -m 0644 /dev/stdin /etc/systemd/system/abra-teleport-novnc.service <<'EOF'
[Unit]
Description=Abra Teleport loopback noVNC server
Requires=abra-teleport-vnc.service
After=abra-teleport-vnc.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now \
  abra-teleport-display.service \
  abra-teleport-window-manager.service \
  abra-teleport-vnc.service \
  abra-teleport-novnc.service

for attempt in $(seq 1 50); do
  if curl --silent --show-error --fail --max-time 2 http://127.0.0.1:6080/vnc.html >/dev/null; then
    echo "Abra Teleport noVNC is ready on 127.0.0.1:6080."
    exit 0
  fi
  sleep 0.2
done

echo "noVNC did not become ready." >&2
systemctl --no-pager --full status abra-teleport-novnc.service >&2 || true
exit 1
