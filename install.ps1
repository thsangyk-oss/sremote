# S-remote installer / updater for Windows
#   irm https://raw.githubusercontent.com/thsangyk-oss/sremote/main/install.ps1 | iex
# Options (env): $env:SREMOTE_DIR to choose install dir
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo     = 'thsangyk-oss/sremote'
$taskName = 'S-remote'
$nodeVer  = 'v22.11.0'   # fallback portable Node LTS - only fetched when no node >=18 found

# ---------- 0. locate existing install -----------------------------------------
function Find-InstallDir {
    if ($env:SREMOTE_DIR) { return $env:SREMOTE_DIR }
    # running server self-reports its root (api/info.root on newer releases)
    try { $r = Invoke-RestMethod 'http://localhost:2209/api/info' -TimeoutSec 2
          if ($r.root -and (Test-Path (Join-Path $r.root 'server.js'))) { return $r.root } } catch {}
    # scheduled task action points at start.bat / start.cmd inside the install dir
    try { $t = Get-ScheduledTask -TaskName 'S-remote' -ErrorAction Stop
          $exe = ($t.Actions[0].Execute -replace '"','')
          $d = Split-Path $exe -Parent
          if ($d -and (Test-Path (Join-Path $d 'server.js'))) { return $d } } catch {}
    # a node process launched with an absolute server.js path
    Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.CommandLine -match '([A-Za-z]:[\\/][^"'']*server\.js)') {
                $d = Split-Path $Matches[1] -Parent
                if (Test-Path (Join-Path $d 'server.js')) { return $d }
            }
        }
    # well-known spots
    foreach ($d in @("$env:LOCALAPPDATA\S-remote", "$env:USERPROFILE\S-remote")) {
        if (Test-Path (Join-Path $d 'server.js')) { return $d } }
    return (Join-Path $env:LOCALAPPDATA 'S-remote')   # fresh default
}
$dir = Find-InstallDir

Write-Host "==> S-remote installer"
Write-Host "    dir: $dir"

# ---------- 1. Node.js ---------------------------------------------------------
function Test-Node { try { return [version]((node --version) -replace '^v','') -ge [version]'18.0.0' } catch { return $false } }
if (-not (Test-Node) -and (Test-Path "$dir\node\node.exe")) { $env:Path = "$dir\node;$env:Path" }
if (-not (Test-Node)) {
    Write-Host "    Node.js >=18 not found - installing portable $nodeVer"
    $nz = Join-Path $env:TEMP "node-$nodeVer.zip"
    Invoke-RestMethod "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip" -OutFile $nz
    $nx = Join-Path $env:TEMP ("node-x-" + [guid]::NewGuid())
    Expand-Archive $nz $nx -Force
    New-Item -ItemType Directory -Force $dir | Out-Null
    if (Test-Path "$dir\node") { Remove-Item "$dir\node" -Recurse -Force }
    Move-Item (Join-Path $nx "node-$nodeVer-win-x64") "$dir\node"
    Remove-Item $nz, $nx -Recurse -Force -ErrorAction SilentlyContinue
    $env:Path = "$dir\node;$env:Path"
    if (-not (Test-Node)) { throw "portable Node install failed" }
}
Write-Host "    node $(node --version), npm $(npm --version)"

# ---------- 2. server payload --------------------------------------------------
$update = Test-Path (Join-Path $dir 'server.js')
Write-Host ($(if ($update) { "    Updating existing install" } else { "    Fresh install" }))
if ($update -and (Test-Path "$dir\.git") -and -not $env:SREMOTE_DIR -and -not $env:SREMOTE_YES) {
    $a = Read-Host "    $dir is a git checkout - overwrite its files with the release? [y/N]"
    if ($a -notmatch '^(y|yes)$') { Write-Host "    Aborted."; return }
}
New-Item -ItemType Directory -Force $dir | Out-Null

$zip = Join-Path $env:TEMP ("sremote-" + [guid]::NewGuid() + ".zip")
try {
    Invoke-RestMethod "https://github.com/$repo/releases/latest/download/sremote-server.zip" -OutFile $zip
} catch {
    Write-Host "    release asset unavailable - falling back to main branch"
    Invoke-RestMethod "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip
}
$tmp = Join-Path $env:TEMP ("sremote-src-" + [guid]::NewGuid())
Expand-Archive $zip $tmp -Force
$src = Get-ChildItem $tmp -Recurse -Filter server.js | Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
if (-not $src) { throw "server.js not found in downloaded package" }
foreach ($f in 'server.js','package.json','package-lock.json','install.bat','start.bat','README.md','public') {
    $p = Join-Path $src $f
    if (Test-Path $p) { Copy-Item $p $dir -Recurse -Force }
}
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 3. dependencies ----------------------------------------------------
Push-Location $dir
try {
    & npm.cmd install --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally { Pop-Location }

# ---------- 4. start.cmd + autostart task --------------------------------------
@"
@echo off
cd /d %~dp0
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
start "" /min node server.js
"@ | Set-Content (Join-Path $dir 'start.cmd') -Encoding ascii

schtasks /create /f /tn $taskName /tr "`"$dir\start.cmd`"" /sc onlogon /rl limited | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "    WARN: could not create scheduled task (autostart skipped)" }

# firewall rule for TCP 2209 - only when elevated; harmless otherwise
net session >$null 2>&1
if ($LASTEXITCODE -eq 0) {
    netsh advfirewall firewall add rule name="S-remote" dir=in action=allow protocol=TCP localport=2209 | Out-Null
}

# ---------- 5. (re)start -------------------------------------------------------
Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$dir\server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($update) {
    # server launched as "node server.js" (relative) hides its dir from cmdline -
    # attribute by port instead: the node process listening on :2209 is ours
    Get-NetTCPConnection -LocalPort 2209 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
        }
}
schtasks /run /tn $taskName >$null 2>&1
if ($LASTEXITCODE -ne 0) { Start-Process -FilePath "$dir\start.cmd" -WindowStyle Hidden }
Start-Sleep -Seconds 2

try {
    $info = Invoke-RestMethod "http://localhost:2209/api/info" -TimeoutSec 4
    Write-Host ""
    Write-Host "OK - S-remote $(if($update){'updated'}else{'installed'}) on $($info.hostname)"
} catch {
    Write-Host ""
    Write-Host "OK - S-remote $(if($update){'updated'}else{'installed'}) (server starting...)"
}
Write-Host "    Local:     http://localhost:2209"
Write-Host "    Tailscale: http://<this-machine-tailscale-ip>:2209"
Write-Host "    Dir:       $dir  (autostarts at logon)"
