# Abra Teleport desktop

Electron UI for the sibling `abra-teleport` CLI. It connects to an internal agent installed inside a sandbox using a short-lived Abra pairing command. Daytona and Firecracker are environments where that agent can run; the app does not require access to their host infrastructure or provider credentials.

Use **Connect your agent** to create one command that installs the CLI if needed and pairs it. Then select the connected sandbox. Then choose a browser tab or Codex session to move. Browser previews and task requests travel through Abra’s authenticated control channel. Browser and workspace data use its signed snapshot transfer.

The app preserves existing cookie selection, device-bound-session exclusions, and workspace divergence checks. A received browser runs in an isolated profile. Codex needs its own installation and login inside the sandbox.

```sh
npm run typecheck
npm run desktop:build
```

The build refreshes the embedded Abra binary, wrapper, browser adapter, shared adapter runtime, observer, and CLI installer. Build output is under `dist/mac-arm64/Abra Teleport.app` on Apple Silicon.

The installer is hosted on versioned AbraApp GitHub Releases and is also exportable as a local archive. Remote connectivity requires outbound Abra transport access from the sandbox.
