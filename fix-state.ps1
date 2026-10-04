# S-remote state recovery
#   irm https://raw.githubusercontent.com/thsangyk-oss/sremote/main/fix-state.ps1 | iex
# Repairs machines where an old installer missed the original install dir
# (e.g. C:\sremote) and did a fresh install into %LOCALAPPDATA% — wiping the
# visible workspaces. This script updates the ORIGINAL dir in place (keeping
# its state.json and re-attaching its live session broker), then removes the
# duplicate install dir the bad update created.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "==> S-remote state recovery"

# ---------- current install = what the running server reports ------------------
$cur = $null
try { $r = Invoke-RestMethod 'http://localhost:2209/api/info' -TimeoutSec 3
      if ($r.root) { $cur = $r.root } } catch {}
if (-not $cur) { $cur = Join-Path $env:LOCALAPPDATA 'S-remote' }
Write-Host "    current install: $cur"

# ---------- find the ORIGINAL install dir (has state.json / live broker) -------
$found = @{}
# 1) any top-level dir on any drive with server.js + state.json (custom installs)
foreach ($drv in (Get-PSDrive -PSProvider FileSystem)) {
    Get-ChildItem $drv.Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $d = $_.FullName
        if ((Test-Path (Join-Path $d 'server.js')) -and (Test-Path (Join-Path $d 'state.json'))) { $found[$d] = $true }
    }
}
# 2) well-known spots + user profile subdirs
foreach ($d in @("$env:LOCALAPPDATA\S-remote", "$env:USERPROFILE\S-remote", "$env:USERPROFILE\sremote")) {
    if (Test-Path (Join-Path $d 'state.json')) { $found[$d] = $true } }
# 3) autostart Run keys -> exe's dir (or its grandparent for agent\tray)
foreach ($rk in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
                'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') {
    try { $v = (Get-ItemProperty $rk -Name 'S-remote' -ErrorAction Stop).'S-remote'
          $d = Split-Path ($v.Trim('"')) -Parent
          if (Test-Path (Join-Path $d 'state.json')) { $found[$d] = $true }
          $d2 = Split-Path (Split-Path $d -Parent) -Parent
          if ($d2 -and (Test-Path (Join-Path $d2 'state.json'))) { $found[$d2] = $true } } catch {}
}

$target = $null; $best = $null; $bestN = -1
foreach ($d in $found.Keys) {
    if (([IO.Path]::GetFullPath($d)) -eq ([IO.Path]::GetFullPath($cur))) { continue }
    $n = 0
    try { $n = @((Get-Content (Join-Path $d 'state.json') -Raw | ConvertFrom-Json).workspaces).Count } catch {}
    # live session broker? session-host.js runs with an absolute path arg,
    # so its command line contains "<dir>\agent\session-host.js"
    $esc = [regex]::Escape((Join-Path $d 'agent\session-host.js'))
    $live = [bool](Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -match $esc })
    Write-Host ("    found: {0,-50} workspaces: {1}  broker: {2}" -f $d, $n, $(if ($live) {'ALIVE'} else {'dead'}))
    # a live broker holds the user's live terminal sessions -> always prefer it
    if ($live) { $target = $d; break }
    if ($n -gt $bestN) { $best = $d; $bestN = $n }
}
if (-not $target) { $target = $best }
if (-not $target) {
    Write-Host "    no older install with saved workspaces found - nothing to restore"
    return
}

# ---------- update the ORIGINAL dir in place ------------------------------------
Write-Host "    -> updating original install at $target"
Write-Host "       (server re-attaches its session broker -> workspaces + live sessions return)"
$env:SREMOTE_DIR = $target
Invoke-Expression (Invoke-RestMethod 'https://raw.githubusercontent.com/thsangyk-oss/sremote/main/install.ps1')

# ---------- remove the duplicate dir the bad update created ---------------------
if ([IO.Path]::GetFullPath($cur) -ne [IO.Path]::GetFullPath($target) -and (Test-Path $cur)) {
    Write-Host ""
    Write-Host "==> removing duplicate install at $cur"
    # kill any leftover processes that lock files inside $cur
    $esc = [regex]::Escape($cur)
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match $esc -or $_.ExecutablePath -match $esc } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-Process SremoteTray -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -match $esc } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    try { Remove-Item $cur -Recurse -Force -ErrorAction Stop
          Write-Host "    removed $cur" }
    catch { Write-Host "    WARN: could not fully remove $cur - delete it manually after a reboot" }
}

Write-Host ""
Write-Host "OK - S-remote restored to original dir: $target"
Write-Host "    reload the web UI - workspaces and live sessions should be back"
