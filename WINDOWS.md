# Native Windows setup

Abra Teleport runs directly on Windows x64 with Electron, a native Rust engine,
and Windows named pipes. WSL, Bash, and Python are not required on the laptop.
The paired agent still runs in a Linux sandbox.

## Install

Download the Windows installer from [abra.vividh.lol](https://abra.vividh.lol),
run the `.exe`, then open Abra Teleport from the Start menu. Install Google
Chrome if it is not already on your computer. The installer includes the Abra
runtime; WSL, Node.js, Rust, and PowerShell commands are not needed.

The native preview targets Windows x64 and is unsigned.

## Develop

Install Node.js 22+, Git, Rust 1.91+ with the `x86_64-pc-windows-msvc` toolchain,
and Visual Studio Build Tools with **Desktop development with C++** (including
the Windows SDK). Install Google Chrome for the managed capture window.

Run in PowerShell from the repository root:

```powershell
git submodule update --init --recursive
npm ci
npm run setup:windows
npm run desktop
```

`setup:windows` applies the checked-in Windows engine patch and builds
`abra/target/debug/abra.exe`. It can be run again safely. The patch remains in
`patches/abra-windows.patch` until the changes are incorporated into the upstream
core submodule. This intentionally leaves the submodule working tree modified;
no separate submodule commit is required to reproduce the Windows build.

Use **Open Abra browser**, sign in to the sites you want to transfer, then refresh
tabs in the app. Windows uses a separate Chrome profile under
`%USERPROFILE%\.abra-teleport\chrome-profile`; it does not read your regular
Chrome profile. Set `CHROME_BIN` to a Chrome executable if it is installed in a
custom location. App state defaults to `%USERPROFILE%\.abra-teleport`.

## Disk and cookie safety

Native Rust builds require at least 8 GiB free and stop their process tree if
available space drops below a 2 GiB reserve. The guard checks the build, Cargo,
and temporary-file volumes. These checks reduce the risk of disrupting Chrome
and other applications; they cannot prevent another program from filling the disk.
Abra also refuses new browser capture/import operations below 1 GiB free.

Managed Chrome profiles must not overlap the regular Chrome data directory,
including through Windows junctions. Session files are written to a new private
file, flushed, and atomically replaced so a failed write retains the old file.

A Google sign-out does not by itself prove cookie corruption. This setup does
not delete, reset, or repair regular Chrome cookies automatically. A locked
cookie database cannot be checked safely until Chrome releases it; back up a
closed profile before any recovery attempt. Session tokens rejected by Google
cannot be repaired by editing the local cookie database.

## Build an installer

```powershell
npm run build:windows
```

This builds the release engine and creates a per-user NSIS installer under
`desktop/dist/windows-native/`. The installer bundles Electron's Node runtime,
the native engine, the adapters, and the verified Linux agent archive pinned by
`docs/install.sh`. The build needs internet access to download release assets.
The installed app does not require Node or Rust on the destination computer.
Preview builds are unsigned; configure code signing for production releases.

## Verify

```powershell
npm run check
npm test
```

These basic checks run in CI on both Mac and Windows. Desktop builds run
manually and check the installed runtime before publishing.

For an optional browser integration check:

```powershell
$env:ABRA_TELEPORT_BROWSER_INTEGRATION = '1'
npm test
```

After building the installer, verify its bundled runtime with
`$env:ABRA_WINDOWS_PACKAGED_TEST = '1'; npm --prefix desktop test`.

Browser integration tests use temporary profiles and synthetic session data.
Unix socket discovery and Bash installer tests run on Unix and are skipped on
Windows. Windows process identity and browser discovery tests run locally.

The previous WSL distribution is still available through
`npm run build:windows:wsl`; see [legacy WSL setup](WINDOWS-WSL.md).
