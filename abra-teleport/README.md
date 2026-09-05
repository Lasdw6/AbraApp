# Abra Teleport

Teleport is a consumer app for moving selected browser sessions and Codex workspaces between your laptop and an agent’s sandbox.

## Connect an agent

1. Open the desktop app and choose **Connect your agent**.
2. Choose **Create connection command** and give it to your agent.
3. The command installs the CLI if needed, then pairs with your laptop.
4. Choose **Find connected agents** and select the sandbox.

The pairing command expires after ten minutes. Generate another if setup takes longer. For offline installation, export the archive with **Save CLI installer**, extract it in the sandbox, and run `bash abra-teleport/scripts/install-agent.sh`.

The CLI runs inside the sandbox. It starts Abra, announces itself to your laptop, and handles browser sessions and workspaces there. The app needs no Daytona API key, SSH key, Firecracker host access, or provider SDK. An agent needs normal command execution, writable user storage, and outbound access to Abra’s transport. A provider blocking relay traffic can still prevent a connection; Teleport reports the transport error rather than bypassing it.

Pairing grants device trust. Only pair agents you trust. The remote interface allows Teleport browser operations and Codex tasks; it does not expose arbitrary shell commands. Each connected agent accepts control only through its designated capsule.

## Browser handoff

Pick a local Chrome tab and choose its cookies and site storage. **Send tab to cloud** transfers the selected state to an isolated browser owned by the agent. The app shows a screenshot preview with click, text, and keyboard controls. **Bring back to this Mac** imports the updated state locally before clearing the remote context.

Local passwords, full history, browser settings, client certificates, and device-bound credentials are not transported. Domain boundaries matter: site credentials are not confined to one tab. Device-bound sessions can fail to transfer.

## Codex handoff

Select a completed session and workspace. The app moves both through Abra, asks the internal agent to restore them, and can run a Codex task in that workspace. Returning preserves the existing ancestry and local-edit checks. Codex must be installed and authenticated **inside the sandbox**; this flow does not copy your local Codex login.

On Linux, a one-shot internal observer records processes, runtimes, resources, and service recipes. Workspace snapshots pin that observation with a unique barrier. No host-side observer or provider API is needed.

## Agent installation

Linux and macOS on x86_64 or arm64 are supported by the installer. It installs under the current user’s home without sudo. The archive includes Abra source and the builder’s native binary. On another platform it installs Rust 1.91 and builds the included source; this needs a compiler/linker and internet access to Rust dependencies. Node 22 is downloaded with a checksum check if a suitable Node is absent. Python 3 is required for Linux observation. Browser handoffs need Chrome/Chromium; sandbox-managed Linux Chrome uses the surrounding sandbox for isolation.

The installer is distributed through versioned AbraApp GitHub Releases. The bootstrap checks the archive SHA-256 before extracting it. Published Linux x64 builds include a static Abra binary.

## Build and test

The Electron app lives in the sibling `desktop` directory. Its `npm run desktop:build` rebuilds Abra, prepares the agent installer, and bundles the current wrapper, browser adapter, shared adapter runtime, and observer.

```sh
npm test
ABRA_TELEPORT_INTEGRATION=1 ABRA_TELEPORT_BROWSER_INTEGRATION=1 npm test
bash scripts/package-agent.sh
```

Integration tests run isolated local Abra peers and Chrome profiles, including pairing, remote control, browser round trips, Codex round trips, and rejection of divergent local edits. They do not claim a live Daytona or Firecracker result.
