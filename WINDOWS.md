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

`setup:windows` verifies the Rust toolchain and the pinned `abra/` submodule,
then builds `abra/target/debug/abra.exe` for `x86_64-pc-windows-msvc`. It can be
run again safely. Use `npx tsx scripts/build-windows-core.ts --prepare-only` to
check the toolchain and pin without compiling.

Use **Open Abra browser**, sign in to the sites you want to transfer, then refresh
tabs in the app. Windows uses a separate Chrome profile under
`%USERPROFILE%\.abra-teleport\chrome-profile`; it does not read your regular
Chrome profile. Set `CHROME_BIN` to a Chrome executable if it is installed in a
custom location. App state defaults to `%USERPROFILE%\.abra-teleport`.

### Windows support lives in the pinned engine

There is no compatibility patch any more. The named-pipe cadabra transport, the
`.py`/`.js` adapter interpreter dispatch (`ABRA_NODE_BIN`, `ABRA_PYTHON_BIN`),
the Windows Chrome discovery, and the atomic browser-session writes are part of
the upstream [Abra](https://github.com/Lasdw6/Abra) repository. To move to a
newer engine:

```powershell
git -C abra fetch origin
git -C abra checkout <commit>
git add abra
npm run setup:windows
```

`scripts/check-abra-pin.ts` guards this. It fails with

```
abra submodule pin lacks native Windows support; bump abra/ to a commit that contains crates/cadabra/src/local.rs
```

when `abra/` is uninitialized or pinned to a commit from before that support
landed. `npm run setup:windows`, `npm run build:windows`, and both Windows CI
jobs run it first, so an old pin fails immediately instead of part way through a
Rust build.

## Disk and cookie safety

Native Rust builds require at least 8 GiB free and stop their process tree if
available space drops below a 2 GiB reserve. The guard checks the build, Cargo,
and temporary-file volumes. These checks reduce the risk of disrupting Chrome
and other applications; they cannot prevent another program from filling the disk.
Abra also refuses new browser capture/import operations below 1 GiB free.

`%USERPROFILE%\.abra-teleport` is created with inheritance removed and full
control granted only to the current user (`icacls`), because the POSIX `0700`
mode Abra uses elsewhere does nothing on Windows. Replacing a state file retries
the brief `EPERM`/`EBUSY`/`EACCES` locks that antivirus and Search indexing
cause, so a scan cannot corrupt a saved selection.

Managed Chrome profiles must not overlap the regular Chrome data directory,
including through Windows junctions. Session files are written to a new private
file, flushed, and atomically replaced so a failed write retains the old file.
Closing the managed browser asks its windows to close first (`taskkill` without
`/F`) and only force-ends the process tree if it does not exit within five
seconds, so Chrome can flush cookies and site storage.

A Google sign-out does not by itself prove cookie corruption. This setup does
not delete, reset, or repair regular Chrome cookies automatically. A locked
cookie database cannot be checked safely until Chrome releases it; back up a
closed profile before any recovery attempt. Session tokens rejected by Google
cannot be repaired by editing the local cookie database.

## Build an installer

```powershell
npm run build:windows
```

This checks the submodule pin, builds the release engine, and creates a per-user
NSIS installer under `desktop/dist/windows-native/`. The installer bundles
Electron's Node runtime, the native engine, the adapters, and the verified Linux
agent archive pinned by `docs/install.sh`. The build needs internet access to download release assets.
The installed app does not require Node or Rust on the destination computer.
Preview builds are unsigned.

### Code signing

Windows SmartScreen warns about unsigned installers. To sign a production
release:

1. Obtain an OV or EV code-signing certificate. EV certificates are held on a
   hardware token or in a cloud HSM and build reputation immediately.
2. Import the certificate into the build machine's `CurrentUser\My` store, or
   provide `CSC_LINK` (a base64 `.pfx` or a file path) and `CSC_KEY_PASSWORD`
   as CI secrets. Never commit a certificate or its password.
3. Fill in the `win.certificateSubjectName` and `win.signtoolOptions`
   placeholders documented in `desktop/scripts/package-windows.ts`, and remove
   `signExecutable: false`.
4. Rebuild and confirm with `Get-AuthenticodeSignature` on both the installer
   and the installed `Abra Teleport.exe`.

### Updates

Packaged builds check for new releases on startup through `electron-updater`,
using the GitHub provider configured in `desktop/package.json`
(`build.publish`). The check only runs when `app.isPackaged` is true, so it
never fires in development. Publishing a GitHub Release that contains the NSIS
installer and its `latest.yml` is what makes an update available. Unsigned
updates still install, but Windows shows its usual publisher warning.

### Deep links

The app registers the `abra-teleport://` protocol (`build.protocols` plus
`app.setAsDefaultProtocolClient`) and holds a single-instance lock, so a link
opened while the app is running raises the existing window rather than starting
a second copy. Deep links are currently logged and bring the window forward;
there is no pairing-ticket entry point in the interface to route them into yet.

## Verify

```powershell
npm run check
npm test
```

Both run in CI. The macOS job runs `npm run check` and `npm test`. The Windows
job additionally verifies the submodule pin, installs the Rust toolchain pinned
by `abra/rust-toolchain.toml`, and runs
`cargo check -p abra-cli --manifest-path abra/Cargo.toml`.

Desktop builds run from the **Desktop builds** workflow, manually or on a push
to `main` that touches `abra`, `scripts/`, `desktop/`, or `abra-teleport/`, and
on `desktop-*` tags. After building the installer it installs it, checks the
installed runtime, reruns the desktop tests with
`ABRA_WINDOWS_PACKAGED_TEST=1`, and runs `cargo test -p cadabra ... local::` to
exercise the named-pipe transport.

For an optional browser integration check:

```powershell
$env:ABRA_TELEPORT_BROWSER_INTEGRATION = '1'
npm test
```

After building the installer, verify its bundled runtime with
`$env:ABRA_WINDOWS_PACKAGED_TEST = '1'; npm --prefix desktop test`.

Browser integration tests use temporary profiles and synthetic session data.
Bash installer and agent-installer tests need a POSIX shell and are skipped on
Windows. Tests that import the browser adapter from `abra/` skip with an
explanation when the submodule is uninitialized. Windows process identity,
command-line quoting, private-file replacement, profile path normalization,
Chrome shutdown, and Chrome discovery tests all run locally.

The previous WSL distribution is still available through
`npm run build:windows:wsl`; see [legacy WSL setup](WINDOWS-WSL.md).
