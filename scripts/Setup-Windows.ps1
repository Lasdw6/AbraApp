# Run from the extracted Windows setup folder. Requires Windows PowerShell 5.1+.
[CmdletBinding()]
param([ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distribution = 'Ubuntu-24.04', [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Run this setup in PowerShell on Windows.' }
if ([Environment]::OSVersion.Version.Build -lt 19044) { throw 'Windows 11 or Windows 10 build 19044 or later is required.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
    throw 'This preview supports Intel/AMD 64-bit Windows. Windows ARM is not packaged yet.'
}

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
foreach ($file in @('app.tar.gz', 'install-wsl.sh', 'launch-wsl.sh', 'icon.ico')) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $manifest.sha256.$file) { throw "Checksum mismatch for $file. Extract a fresh setup archive." }
}

$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
if (!(Test-Path -LiteralPath $wsl)) { throw 'Install WSL from https://aka.ms/wslinstall, restart Windows, then run this setup again.' }
$distributions = ((& $wsl --list --quiet 2>$null) -join "`n").Replace([string][char]0, '')
if ($LASTEXITCODE -ne 0 -or !(($distributions -split "`n" | ForEach-Object { $_.Trim() }) -contains $Distribution)) {
    Write-Host "Installing WSL and $Distribution. Windows may ask for administrator access."
    & $wsl --install --distribution $Distribution --no-launch
    if ($LASTEXITCODE -ne 0) { throw "WSL installation did not finish. Run 'wsl --install -d $Distribution' as Administrator, restart if requested, then rerun setup." }
    Write-Host 'Finish creating your Linux username in the Ubuntu window, then type exit. If Windows requests a restart, rerun this setup after restarting.'
    & $wsl --distribution $Distribution
    if ($LASTEXITCODE -ne 0) { throw 'Ubuntu setup did not finish. Restart Windows if requested, finish Ubuntu setup, then rerun this installer.' }
}

$kernel = (& $wsl --distribution $Distribution --exec uname -r) -join ''
if ($LASTEXITCODE -ne 0 -or $kernel -notmatch 'microsoft-standard|WSL2') {
    throw "WSL 2 is required. Run 'wsl --set-version $Distribution 2' and 'wsl --update', then rerun setup."
}
& $wsl --distribution $Distribution --exec test -d /mnt/wslg
if ($LASTEXITCODE -ne 0) { throw "WSL desktop support is missing. Run 'wsl --update' followed by 'wsl --shutdown', then rerun setup." }
$linuxPath = (& $wsl --distribution $Distribution --exec wslpath -a -u $PSScriptRoot) -join ''
if ($LASTEXITCODE -ne 0 -or !$linuxPath.StartsWith('/')) { throw 'Could not find the extracted setup folder from Ubuntu.' }
# Arguments go directly to wsl.exe; Windows paths are never evaluated as shell code.
& $wsl --distribution $Distribution --exec bash "$linuxPath/install-wsl.sh" "$linuxPath"
if ($LASTEXITCODE -ne 0) { throw 'Abra installation failed inside Ubuntu. See the error above; rerun setup after fixing it.' }

$iconDirectory = Join-Path $env:LOCALAPPDATA 'Abra Teleport'
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null
$iconPath = Join-Path $iconDirectory 'icon.ico'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'icon.ico') -Destination $iconPath -Force

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Abra Teleport.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wsl
$shortcut.Arguments = "--distribution $Distribution --exec /opt/abra-teleport/launch-wsl.sh"
$shortcut.IconLocation = $iconPath
$shortcut.Description = 'Abra Teleport (WSL)'
$shortcut.Save()
Write-Host 'Abra Teleport is installed. Use the desktop shortcut to open it. Sign in to sites inside the Abra browser.'
if (!$NoLaunch) { & $wsl --distribution $Distribution --exec /opt/abra-teleport/launch-wsl.sh }
