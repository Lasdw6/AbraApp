# Windows preview (WSL)

Abra Teleport can run as a desktop window on Windows through WSL 2 and WSLg. This is a Linux build running locally on your Windows computer, not a native Windows executable.

## Install

Requires Intel/AMD 64-bit Windows 11 or Windows 10 build 19044+, hardware virtualization, and internet access. The setup uses Ubuntu 24.04. Windows ARM is not packaged yet.

1. [Download the Windows setup](https://github.com/Lasdw6/AbraApp/releases/download/v0.3.0-rc.3/Abra-Teleport-Windows-WSL-x64.zip), then extract `Abra-Teleport-Windows-WSL-x64.zip` into a local folder. Keep all extracted files together.
2. Open PowerShell in the extracted `Abra-Teleport-Windows-WSL` folder and run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-Windows.ps1
   ```

3. If WSL needs installation, finish the Ubuntu username/password prompt. Windows may require administrator access or a restart. Rerun the same setup after restarting.
4. Enter your Ubuntu password when setup installs dependencies. Open **Abra Teleport** from the desktop shortcut.

If you already have a differently named Ubuntu 24.04 distribution, pass `-Distribution YourDistroName`. Setup checks that it uses WSL 2 and has desktop support. It does not change your default distribution.

The setup verifies the package checksums, installs the app and its Node/Rust runtime under `/opt/abra-teleport`, and installs Chrome inside Ubuntu. The app runs as your normal Linux user, with the Chromium sandbox enabled. No Rust compiler or separate Node installation is needed.

This preview is unsigned. The PowerShell command bypasses script execution policy for that process only; it does not change your saved policy. Inspect the scripts before running them if needed.

## Use

- Click **Open Abra browser**, visit a site and sign in, then refresh tabs and select the tab and cookies to send. Cookies and storage come from that selected tab in the Abra browser. Regular Windows Chrome/Edge profiles are not imported.
- Create a connection command in **Connect your agent** and run it inside the agent's Linux sandbox. Daytona and Firecracker use the same internal CLI. You do not need provider API keys or host access; the sandbox must permit Abra's network traffic.
- Keep Windows and WSL running while a transfer is in progress. If WSLg is missing, run `wsl --update`, then `wsl --shutdown` in PowerShell and reopen the app.

To uninstall, close the app and run `sudo rm -rf /opt/abra-teleport` inside Ubuntu, remove `~/.local/bin/abra-teleport` and `~/.local/share/applications/abra-teleport.desktop`, then delete the Windows desktop shortcut. Your state in `~/.abra-teleport`, workspaces, and Chrome remain unless you separately remove them.

## Build and validation

From the repository, run `npm ci` followed by `npm run build:windows:wsl` on macOS or Linux. Build the Rust core first (`cargo build --locked --release --manifest-path abra/Cargo.toml -p abra-cli`). On macOS, provide a Linux x64 Abra binary in `abra-teleport/dist/native/linux-x64/abra` or set `ABRA_LINUX_BIN` to it. The packager rejects a binary for the wrong operating system or CPU, bundles checksum-pinned Node 22.23.2, and writes the setup zip under `desktop/dist/`.

The browser integration suite exercises the managed browser against real Chrome, including selected-tab session storage, cookie selection, navigation checks, and preparing a handoff. Existing tests cover pairing and browser round trips and connection loss/recovery. The packaged application also passed nine live checks on a fresh Ubuntu 24.04 EC2 instance: bundled Node/core, pairing command, managed browser interface, headed Chrome, tab discovery, cookie inventory, handoff preparation, and cleanup. A packaging resource collision found during this test was fixed; the build now verifies the packaged core against its source checksum. Windows first-run prompts, WSLg windows, and the desktop shortcut still require validation on a Windows computer. Building an archive alone does not verify those behaviors.
