# Abra Teleport desktop

Electron UI for the sibling `abra-teleport` CLI. It connects to an internal agent installed inside a sandbox using a short-lived Abra pairing command. Daytona and Firecracker are environments where that agent can run; the app does not require access to their host infrastructure or provider credentials.

Use **Connect your agent** to create one command that installs the CLI if needed and pairs it. Then select the connected sandbox and choose a browser tab to move. Connection checks and session actions travel through Abra’s authenticated control channel. The app shows session details, Bring back, and Revoke session; use the browser on the agent’s computer. Browser data use its signed snapshot transfer.

The app preserves existing cookie selection and device-bound-session exclusions. A received session runs in an isolated browser context. Abra reuses a compatible browser on the sandbox’s display, or starts a visible browser there; it falls back to headless only when no display is available.

The header checks connection health every 15 seconds and shows the last successful contact time. Unreachable agents remain paired and can reconnect without setup.

Source lives in `src/`, `electron/`, and `shared/` as TypeScript. The preload and renderer share one typed IPC contract. Install dependencies with `npm ci` from the repository root.

```sh
npm run typecheck
npm run desktop:build
```

To look at the UI without a paired agent, build the web bundle and render a state with fake data:

```sh
npx vite build
npx electron scripts/screenshot.cjs out.png selected   # pick | selected | cloud | offline | unpaired | popover | command
```

The build refreshes the embedded Abra binary, wrapper, browser adapter, shared adapter runtime, observer, and CLI installer. Build output is under `dist/mac-arm64/Abra Teleport.app` on Apple Silicon.

The installer is hosted on versioned AbraApp GitHub Releases and is also exportable as a local archive. Remote connectivity requires outbound Abra transport access from the sandbox.
