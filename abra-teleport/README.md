# Abra Teleport

Teleport is a consumer app for moving selected browser sessions between your laptop and an agent’s sandbox.

## Connect an agent

1. Open the desktop app and choose **Connect your agent**.
2. Choose **Create connection command** and give it to your agent.
3. The command installs the CLI if needed, then pairs with your laptop.
4. Choose **Find connected agents** and select the sandbox.

The pairing command expires after ten minutes. Generate another if setup takes longer. For offline installation, export the archive with **Save CLI installer**, extract it in the sandbox, and run `bash abra-teleport/scripts/install-agent.sh`.

The CLI runs inside the sandbox. It starts Abra, announces itself to your laptop, and handles browser sessions there. The app needs no Daytona API key, SSH key, Firecracker host access, or provider SDK. An agent needs normal command execution, writable user storage, and outbound access to Abra’s transport. A provider blocking relay traffic can still prevent a connection; Teleport reports the transport error rather than bypassing it.

Pairing grants device trust. Only pair agents you trust. The remote interface allows Teleport browser operations and read-only connection checks; it does not expose arbitrary shell commands. Each connected agent accepts control only through its designated capsule.

## Browser handoff

Pick a local Chrome tab and choose its cookies and site storage. **Send to your agent** creates an isolated browser context in the sandbox. **Send another tab** returns to the picker while existing sessions remain available in the navigation bar. Each session has its own **Bring back** and **Revoke session** actions; returning one does not remove the others.

Open **Sandbox tabs** to list HTTP/HTTPS tabs in compatible Chrome browsers on the agent’s display. Choose a tab to pull its portable cookies and site storage to the laptop. The app does not deliberately close the original tab. Chrome must expose a local debugging endpoint for Abra to read it.

Agents can initiate a send using the installed CLI:

```sh
abra-teleport browser available-tabs
abra-teleport browser send-tab <tab-id>
```

The send is pinned to the paired laptop. Abra captures only the selected tab’s portable cookies, storage, and page state. It appears under **Sandbox tabs → Sent by your agent**; choose **Open on this computer** to import it. Receiving a tab does not run a command from the agent. Previously received tabs can be opened while the sandbox is offline.

Existing agent installations must be updated to this release to use multiple sessions and sandbox tab sending. Extract the new agent archive and run `bash abra-teleport/scripts/install-agent.sh`; pairing state is preserved. A second outgoing session is refused safely when the agent still has the older CLI.

Local passwords, full history, browser settings, client certificates, and device-bound credentials are not transported. Domain boundaries matter: site credentials are not confined to one tab. Device-bound sessions can fail to transfer. Revoke clears the imported browser context; use the website’s session settings to invalidate its login token globally.

## Connection status

The app checks the selected agent every 15 seconds, without interrupting browser transfers. A successful authenticated response shows **Agent connected**. An eight-second remote request timeout or failed identity check shows **Agent unreachable** and retains the last successful contact time. With no selected agent it shows **No agent connected**. Use the refresh button to check immediately.

This reports whether the Abra runtime is reachable. It does not claim that the model is working, idle, or consuming tokens.

## Agent installation

Linux and macOS on x86_64 or arm64 are supported by the installer. It installs under the current user’s home without sudo. The archive includes Abra source and the builder’s native binary. On another platform it installs Rust 1.91 and builds the included source; this needs a compiler/linker and internet access to Rust dependencies. Node 22 is downloaded with a checksum check if a suitable Node is absent. Python 3 is required for Linux observation. Browser handoffs need Chrome/Chromium; sandbox-managed Linux Chrome uses the surrounding sandbox for isolation.

The installer is distributed through versioned AbraApp GitHub Releases. The bootstrap checks the archive SHA-256 before extracting it. Published Linux x64 builds include a static Abra binary.

## Build and test

Run `npm ci` from the repository root. The CLI, adapters, and tests are TypeScript; `npm run build` compiles runtime files into `build/` and copies adapter manifests and shell installers. Run the development CLI with `node build/bin/abra-teleport.js`. Packaged installations contain only the compiled runtime and do not need TypeScript or npm dependencies.


The Electron app lives in the sibling `desktop` directory. Its `npm run desktop:build` rebuilds Abra, prepares the agent installer, and bundles the current wrapper, browser adapter, shared adapter runtime, and observer.

```sh
npm test
ABRA_TELEPORT_INTEGRATION=1 ABRA_TELEPORT_BROWSER_INTEGRATION=1 npm test
bash scripts/package-agent.sh
```

Integration tests run isolated local Abra peers and Chrome profiles, including pairing, remote control, browser round trips, and connection loss/recovery. They do not claim a live Daytona or Firecracker result.

### Sandbox browser selection

Abra reuses a running Chrome/Chromium debugging endpoint on the agent’s Linux display. If none is available, it opens a visible browser when a desktop is available, or headless Chrome when there is no display. A single X display can be discovered even when the agent tool omits `DISPLAY`; multiple displays require `DISPLAY` or `WAYLAND_DISPLAY` to identify the agent’s desktop.

For a browser that cannot be discovered automatically, set `ABRA_TELEPORT_CDP_URL` to its local HTTP debugging address or browser WebSocket URL before starting the agent’s Abra daemon. Explicit `--headed` and `--headless` flags control newly launched browsers. An explicit proxy uses an Abra-managed browser so the requested route is honored.

Imported sessions use a separate browser context. Returning or revoking a session removes that context; Abra never closes a reused browser or its existing tabs. A browser with an active handoff stays attached until that handoff is returned or revoked. Bring back and resend a session to apply the new browser default to an older handoff.

**Revoke session** removes the transferred browser context, including its tab, cookies, and site storage. If the sandbox is unreachable, Abra keeps the handoff visible and reports that removal is unconfirmed. This clears Abra’s browser copy; invalidating the website’s login token everywhere requires the website’s own session controls.
