# S-remote state recovery
#   irm https://raw.githubusercontent.com/thsangyk-oss/sremote/main/fix-state.ps1 | iex
# Restores state.json (workspaces + session history) after an update that
# installed into a different directory than the original one.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "==> S-remote state recovery"

# ---------- current install = what the running server reports ------------------
$cur = $null
try { $r = Invoke-RestMethod 'http://localhost:2209/api/info' -TimeoutSec 3
      if ($r.root) { $cur = $r.root } } catch {}
if (-not $cur) { $cur = Join-Path $env:LOCALAPPDATA 'S-remote' }
Write-Host "    current install: $cur"
if (-not (Test-Path (Join-Path $cur 'server.js'))) { throw "no server.js in $cur" }

# ---------- find every other dir that still holds a state.json -----------------
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

$best = $null; $bestN = -1
foreach ($d in $found.Keys) {
    if (([IO.Path]::GetFullPath($d)) -eq ([IO.Path]::GetFullPath($cur))) { continue }
    $n = 0
    try { $n = @((Get-Content (Join-Path $d 'state.json') -Raw | ConvertFrom-Json).workspaces).Count } catch {}
    Write-Host ("    found: {0,-50} workspaces: {1}" -f $d, $n)
    if ($n -gt $bestN) { $best = $d; $bestN = $n }
}
if (-not $best -or $bestN -le 0) {
    Write-Host "    no older install with saved workspaces found - nothing to restore"
    return
}

# ---------- migrate state -------------------------------------------------------
Write-Host "    restoring $bestN workspace(s) from $best"
foreach ($f in 'state.json','data') {
    $dst = Join-Path $cur $f
    if (Test-Path $dst) { Copy-Item $dst "$dst.recover-bak" -Recurse -Force -ErrorAction SilentlyContinue }
    $src = Join-Path $best $f
    if (Test-Path $src) { Copy-Item $src $dst -Recurse -Force }
}

# ---------- restart server on the current install -------------------------------
Get-Process SremoteTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 2209 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
$tray = Join-Path $cur 'agent\tray\SremoteTray.exe'
schtasks /run /tn 'S-remote' >$null 2>&1
if ($LASTEXITCODE -ne 0) {
    if (Test-Path $tray) { Start-Process -FilePath $tray }
    else { Start-Process -FilePath (Join-Path $cur 'start.cmd') -WindowStyle Hidden }
}
Start-Sleep -Seconds 2

try {
    $w = Invoke-RestMethod 'http://localhost:2209/api/workspaces' -TimeoutSec 4
    Write-Host "OK - restored. workspaces now: $(@($w).Count)"
    Write-Host "    reload the web UI to see them"
} catch {
    Write-Host "OK - state restored (server still starting - reload the UI in a few seconds)"
}
