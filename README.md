# AbraApp

A desktop app for moving selected browser sessions between your laptop and an agent’s sandbox.

[Download Abra Teleport for Mac or Windows](https://abra.vividh.lol/). For native Windows development and installer builds, see [Windows setup](WINDOWS.md).

The agent CLI installer is served from `https://abra.vividh.lol/install.sh`.

Open **Connect your agent**, create a connection command, and give it to your agent. The command downloads the CLI if it is missing, verifies the archive checksum, installs it under the sandbox user’s home, and pairs with your laptop. If the CLI is already installed, it just pairs. Commands expire after ten minutes; generate another if setup takes longer.

The CLI and observer run inside the sandbox. The app does not need Daytona API keys, SSH keys, or Firecracker host access. Pairing establishes trusted Abra devices. The sandbox must be able to reach Abra’s network; provider network restrictions can block the connection.

Browser transfers include the cookies and site storage you select. Send multiple tabs without leaving earlier sessions behind; each can be returned or revoked separately. **Sandbox tabs** lets you pull a tab from the agent’s Chrome or open an incoming tab sent with `abra-teleport browser send-tab <tab-id>`. The app checks the selected sandbox every 15 seconds and shows whether it is connected, unreachable, or unpaired, plus the last successful contact time. A paired device can be offline; pairing alone is not a live connection.

## Build

```sh
git clone --recurse-submodules https://github.com/Lasdw6/AbraApp.git
cd AbraApp
npm ci
npm run build
```

Requires Node 22+, Rust 1.91+, and Python 3 for Linux observation. Desktop release builds require 8 GiB free and stop when disk space falls below a 2 GiB reserve. The standard desktop build targets macOS. For native Windows, see [Windows setup](WINDOWS.md); `npm run build:windows` creates a Windows x64 installer with a native core binary. The legacy WSL archive is available through `npm run build:windows:wsl`. `desktop/` contains Electron and React; `abra-teleport/` contains the internal CLI; `abra/` pins the core engine as a submodule.

The build creates the app under `desktop/dist/` and installer assets under `abra-teleport/dist/`. It includes the builder’s native binary. Put additional native binaries at `abra-teleport/dist/native/<platform>-<arch>/abra` before building to ship those platforms without source compilation. Linux x64 release builds use musl to support different Linux distributions.

Set `ABRA_TELEPORT_RELEASE_URL` to the versioned GitHub Release directory when preparing a new release. Publish `connect.sh` and `abra-teleport-agent.tar.gz` together: the script embeds the archive’s SHA-256 digest. The pairing ticket is passed to the CLI locally and never sent as part of the installer download URL.

## Source layout

The desktop interface, Electron processes, CLI, adapters, build tools, and tests use TypeScript. A single npm workspace and root lockfile manage their dependencies. `npm run check` checks the source and tests. The CLI builds into `abra-teleport/build/`; Electron builds into `desktop/build-electron/`. Installers contain compiled JavaScript and require no TypeScript tools at runtime.

The pinned `abra/` dependency owns the Rust engine, browser adapter, and Python observer. The old Swift app, SSH/noVNC transport, systemd observer setup, and demo actions have been removed. Consumer connections use the internal paired-agent CLI.

## Test

```sh
npm test
ABRA_TELEPORT_INTEGRATION=1 ABRA_TELEPORT_BROWSER_INTEGRATION=1 npm test
```

Integration tests use isolated Abra state and Chrome profiles. `abra-teleport/build/scripts/live-roundtrip.js` tests a live Linux guest with a JSON configuration containing `provider`, `report_dir`, `install_url`, and a `remote` SSH argument array. SSH only sets up test fixtures and checks their contents; pairing, control, and all handoffs use Abra’s iroh transport. Fixtures use synthetic browser state, not personal credentials.

The `docs/` directory serves the installer through GitHub Pages at `abra.vividh.lol`. When publishing a release, copy its generated `connect.sh` to `docs/install.sh` so the hosted script and release archive have matching checksums.
