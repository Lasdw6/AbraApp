# Abra Teleport desktop

Electron UI for the sibling `abra-teleport` CLI. It connects to an internal agent installed inside a sandbox using a short-lived Abra pairing command. Daytona and Firecracker are environments where that agent can run; the app does not require access to their host infrastructure or provider credentials.

Use **Connect your agent** to create one command that installs the CLI if needed and pairs it. Then select the connected sandbox and choose a browser tab to move. Connection checks and session actions travel through Abra’s authenticated control channel. The app shows session details, Bring back, and Revoke session; use the browser on the agent’s computer. Browser data use its signed snapshot transfer.

Cookie review shows portability hints without claiming that a site will accept a copied session. Cookies flagged by the transfer rules are off by default. **Manually allow cookies and storage** enables them for the selected transfer; users can still deselect individual cookies and storage. The override resets when selecting or reloading a tab, and follows that session on its return trip. Both the desktop and agent CLI/browser adapter must support it; older agents are rejected before capture. The CLI equivalent is `--allow-non-portable`. Domain restrictions and signed transfers still apply. A received session runs in an isolated browser context. Abra reuses a compatible browser on the sandbox’s display, or starts a visible browser there; it falls back to headless only when no display is available.

Chrome tabs appear in a list. Select a row to choose a paired agent and review the cookies before sending. Existing handoffs must be returned or revoked before choosing a different agent. The chosen destination is bound to the send request and becomes the current agent after a successful send.

The app does not capture previews or run JavaScript through Apple Events. Regular Chrome tabs send their URL and selected site data without live scroll or playback capture.

The header checks connection health every 15 seconds and shows the last successful contact time. Unreachable agents remain paired and can reconnect without setup.

Source lives in `src/`, `electron/`, and `shared/` as TypeScript. The preload and renderer share one typed IPC contract. Electron calls the Teleport library through a persistent worker pool, which keeps command environments isolated while avoiding a new CLI process for each request. The standalone `abra-teleport` command uses the same entry point. Install dependencies with `npm ci` from the repository root.

The spoon logo source is `assets/spoon.svg`. After editing it, run `npm run icons` from the repository root to regenerate the app and website assets, including Mac and Windows icons. Commit the generated assets with the source.

```sh
npm run typecheck
npm run desktop:build
```

To look at the UI without a paired agent, build the web bundle and render a state with fake data:

```sh
npx vite build
npx electron scripts/screenshot.cjs out.png selected   # pick | selected | editing | list | cloud | multi | offline | unpaired | remote | popover | command
ABRA_SHOT_LIGHT=1 npx electron scripts/screenshot.cjs out.png pick   # light theme
```

The build refreshes the embedded Abra binary, wrapper, browser adapter, shared adapter runtime, observer, and CLI installer. Build output is under `dist/mac-arm64/Abra Teleport.app` on Apple Silicon.

The installer is hosted on versioned AbraApp GitHub Releases and is also exportable as a local archive. Remote connectivity requires outbound Abra transport access from the sandbox.

For native Windows development, run `npm run setup:windows` from the repository
root, then `npm run desktop`. Build the Windows x64 NSIS installer with
`npm run build:windows`. See [Windows setup](../WINDOWS.md).
