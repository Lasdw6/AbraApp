# AbraApp

A desktop app for moving selected browser sessions and Codex workspaces between your laptop and an agent’s sandbox.

Open **Connect your agent**, create a connection command, and give it to your agent. The command downloads the CLI if it is missing, verifies the archive checksum, installs it under the sandbox user’s home, and pairs with your laptop. If the CLI is already installed, it just pairs. Commands expire after ten minutes; generate another if setup takes longer.

The CLI and observer run inside the sandbox. The app does not need Daytona API keys, SSH keys, or Firecracker host access. Pairing establishes trusted Abra devices. The sandbox must be able to reach Abra’s network; provider network restrictions can block the connection.

Browser transfers include the cookies and site storage you select. Codex workspace transfers preserve local-edit and session ancestry checks. Codex needs its own login inside the sandbox; your local Codex credentials are not copied.

## Build

```sh
git clone --recurse-submodules https://github.com/Lasdw6/AbraApp.git
cd AbraApp
npm --prefix desktop ci
npm run build
```

Requires Node 22+, Rust 1.91+, and macOS for the desktop app. `desktop/` contains Electron and React; `abra-teleport/` contains the internal CLI; `abra/` pins the core engine as a submodule.

The build creates the app under `desktop/dist/` and installer assets under `abra-teleport/dist/`. It includes the builder’s native binary. Put additional native binaries at `abra-teleport/dist/native/<platform>-<arch>/abra` before building to ship those platforms without source compilation. Linux x64 release builds use musl to support different Linux distributions.

Set `ABRA_TELEPORT_RELEASE_URL` to the versioned GitHub Release directory when preparing a new release. Publish `connect.sh` and `abra-teleport-agent.tar.gz` together: the script embeds the archive’s SHA-256 digest. The pairing ticket is passed to the CLI locally and never sent as part of the installer download URL.

## Test

```sh
npm test
ABRA_TELEPORT_INTEGRATION=1 ABRA_TELEPORT_BROWSER_INTEGRATION=1 npm test
```

Integration tests use isolated Abra state and Chrome profiles. `abra-teleport/scripts/live-roundtrip.js` tests a live Linux guest with a JSON configuration containing `provider`, `report_dir`, `install_url`, and a `remote` SSH argument array. SSH only sets up test fixtures and checks their contents; pairing, control, and all handoffs use Abra’s iroh transport. Fixtures use synthetic browser state and a synthetic Codex transcript, not personal credentials or paid model calls.
