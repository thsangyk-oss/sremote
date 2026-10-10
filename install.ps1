# S-remote installer / updater for Windows
#   irm https://raw.githubusercontent.com/thsangyk-oss/sremote/main/install.ps1 | iex
# Options (env): $env:SREMOTE_DIR to choose install dir
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo     = 'thsangyk-oss/sremote'
$taskName = 'S-remote'
$nodeVer  = 'v22.11.0'   # fallback portable Node LTS - only fetched when no node >=18 found

# ---------- 0. locate install dir(s) -------------------------------------------
# Older installers could miss the real install dir and drop a fresh copy into
# %LOCALAPPDATA% — hiding workspaces (state.json) and live sessions (broker).
# Instead of returning the first match we collect EVERY dir that looks like an
# install; if several exist we ask the user: fresh install, or fix + install
# into the original dir (re-attaches sessions, merges state, removes dupes).
$script:runningRoot    = $null   # dir the :2209 server reports (api/info.root)
$script:liveBrokerDir  = $null   # dir whose session-host.js broker is alive
$candSet = [ordered]@{}

function Add-InstallCandidate([string]$d) {
    if (-not $d) { return }
    if (-not (Test-Path (Join-Path $d 'server.js'))) { return }
    $p = [IO.Path]::GetFullPath($d).TrimEnd('\')
    if (-not $candSet.Contains($p)) { $candSet[$p] = $true }
}
function Get-WsCount($d) {
    try { return @((Get-Content (Join-Path $d 'state.json') -Raw -ErrorAction Stop | ConvertFrom-Json).workspaces).Count }
    catch { return 0 }
}
function Get-DirInfo($d) {
    $bits = @()
    if ($script:liveBrokerDir -eq $d) { $bits += 'live sessions' }
    if ($script:runningRoot -eq $d)   { $bits += 'running now' }
    $bits += "$(Get-WsCount $d) workspace(s)"
    return ($bits -join ', ')
}

# a) running server self-reports its root (api/info.root on v1.2.1+)
try { $r = Invoke-RestMethod 'http://localhost:2209/api/info' -TimeoutSec 2
      if ($r.root) { $script:runningRoot = [IO.Path]::GetFullPath($r.root).TrimEnd('\'); Add-InstallCandidate $r.root } } catch {}

# b) port owner fallback for servers too old to report root: the :2209 listener's
#    node.exe under <dir>\node reveals a portable install
try { Get-NetTCPConnection -LocalPort 2209 -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        $pe = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_)" -ErrorAction SilentlyContinue).ExecutablePath
        if ($pe -match '([A-Za-z]:[\\/][^"'']*)[\\/]node[\\/]node\.exe') { Add-InstallCandidate $Matches[1] }
      } } catch {}

# c) node processes: absolute server.js paths, live session broker, tray parent
foreach ($p in (Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue)) {
    if ($p.CommandLine -match '([A-Za-z]:[\\/][^"'']*)[\\/]agent[\\/]session-host\.js') {
        Add-InstallCandidate $Matches[1]
        $script:liveBrokerDir = [IO.Path]::GetFullPath($Matches[1]).TrimEnd('\')
    }
    if ($p.CommandLine -match '([A-Za-z]:[\\/][^"'']*server\.js)') {
        Add-InstallCandidate (Split-Path $Matches[1] -Parent)
    }
    # "node server.js" (relative) hides its dir — its parent is the tray exe,
    # whose absolute path sits at <dir>\agent\tray\SremoteTray.exe
    if ($p.ParentProcessId) {
        $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($par -and $par.ExecutablePath -match '([A-Za-z]:[\\/][^"'']*)[\\/]agent[\\/]tray[\\/]SremoteTray\.exe') { Add-InstallCandidate $Matches[1] }
        if ($par -and $par.CommandLine     -match '([A-Za-z]:[\\/][^"'']*)[\\/](start\.cmd|start\.bat)')      { Add-InstallCandidate $Matches[1] }
    }
}
Get-CimInstance Win32_Process -Filter "name='SremoteTray.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.ExecutablePath -match '([A-Za-z]:[\\/][^"'']*)[\\/]agent[\\/]tray[\\/]SremoteTray\.exe') { Add-InstallCandidate $Matches[1] }
}

# d) scheduled task action -> start.cmd in root, or tray exe two levels down
try { $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $exe = ($t.Actions[0].Execute -replace '"','')
      $d = Split-Path $exe -Parent
      Add-InstallCandidate $d                                            # <dir>\start.cmd
      Add-InstallCandidate (Split-Path (Split-Path $d -Parent) -Parent)  # <dir>\agent\tray\*.exe
} catch {}

# e) autostart Run keys -> same shapes as the scheduled task
foreach ($rk in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
                'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') {
    try { $v = (Get-ItemProperty $rk -Name 'S-remote' -ErrorAction Stop).'S-remote'
          $d = Split-Path ($v.Trim('"')) -Parent
          Add-InstallCandidate $d
          Add-InstallCandidate (Split-Path (Split-Path $d -Parent) -Parent) } catch {}
}

# f) every top-level dir on every drive, plus one "sremote"-named level deeper
#    (covers C:\sremote, D:\tools\sremote, X:\myserver, ...)
foreach ($drv in (Get-PSDrive -PSProvider FileSystem)) {
    Get-ChildItem $drv.Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        Add-InstallCandidate $_.FullName
        foreach ($n in 'S-remote','Sremote','sremote') { Add-InstallCandidate (Join-Path $_.FullName $n) }
    }
}

# g) well-known spots
foreach ($d in @("$env:LOCALAPPDATA\S-remote", "$env:USERPROFILE\S-remote", "$env:USERPROFILE\sremote",
                 "$env:USERPROFILE\Desktop\S-remote", "$env:USERPROFILE\Documents\S-remote", "$env:ProgramData\S-remote")) {
    Add-InstallCandidate $d
}

$cands    = @($candSet.Keys)
$dir      = $null
$fixDupes = @()

if ($env:SREMOTE_DIR) {
    $dir = [IO.Path]::GetFullPath($env:SREMOTE_DIR).TrimEnd('\')
} elseif ($cands.Count -eq 0) {
    $dir = Join-Path $env:LOCALAPPDATA 'S-remote'   # fresh default
} elseif ($cands.Count -eq 1) {
    $dir = $cands[0]
} else {
    # original = live broker > most workspaces > currently running > first
    $primary = $null
    if ($liveBrokerDir -and ($cands -contains $liveBrokerDir)) { $primary = $liveBrokerDir }
    if (-not $primary) {
        $primary = $cands | Sort-Object -Descending `
            @{ e = { Get-WsCount $_ } }, @{ e = { $_ -eq $script:runningRoot } } |
            Select-Object -First 1
    }
    # "fresh" choice = the dir the (duplicate) server is running from now
    $freshDir = if ($script:runningRoot -and ($cands -contains $script:runningRoot) -and $script:runningRoot -ne $primary) { $script:runningRoot }
                else { ($cands | Where-Object { $_ -ne $primary } | Select-Object -First 1) }
    if (-not $freshDir) { $freshDir = $primary }

    Write-Host ""
    Write-Host "    !! multiple S-remote installs detected:"
    foreach ($d in $cands) { Write-Host ("       - {0}  ({1})" -f $d, (Get-DirInfo $d)) }
    Write-Host ""
    Write-Host "    [1] Fresh install into $freshDir"
    Write-Host "        (other installs stay on disk untouched; their workspaces are NOT migrated)"
    Write-Host "    [2] FIX bad update + install into $primary"
    Write-Host "        (keeps workspaces, re-attaches live sessions, then removes duplicate dirs)"
    $choice = $env:SREMOTE_MODE
    if (-not $choice) { try { $choice = Read-Host "    Choice [1/2, default 2]" } catch { $choice = '2' } }
    if ($choice -eq '1' -or $choice -match '^(fresh|new)$') { $dir = $freshDir }
    else { $dir = $primary; $fixDupes = @($cands | Where-Object { $_ -ne $primary }) }
}

if ($env:SREMOTE_PROBE_ONLY) {
    Write-Host "==> probe only"
    foreach ($d in $cands) { Write-Host ("    cand: {0}  ({1})" -f $d, (Get-DirInfo $d)) }
    Write-Host "    chosen dir: $dir"
    Write-Host "    fixDupes:   $($fixDupes -join '; ')"
    return
}

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

# preserve user state across updates (workspaces/session history live in the install dir)
if ($update) {
    foreach ($f in 'state.json','data') {
        $p = Join-Path $dir $f
        if (Test-Path $p) { Copy-Item $p "$p.install-bak" -Recurse -Force -ErrorAction SilentlyContinue } }
}

# fix mode: merge state from a duplicate dir if it accumulated MORE workspaces
# than the original while it was active (e.g. user kept working on the dupe)
foreach ($dupe in $fixDupes) {
    $ds = Join-Path $dupe 'state.json'
    if (-not (Test-Path $ds)) { continue }
    $dn = Get-WsCount $dupe
    $ms = Join-Path $dir 'state.json'
    $mn = Get-WsCount $dir
    # always keep a copy of the dupe's state inside the original dir for manual recovery
    Copy-Item $ds "$dir\state.json.dupe-bak" -Force -ErrorAction SilentlyContinue
    if (Test-Path "$dupe\data") { Copy-Item "$dupe\data" "$dir\data.dupe-bak" -Recurse -Force -ErrorAction SilentlyContinue }
    if ($dn -gt $mn) {
        if (Test-Path $ms) { Copy-Item $ms "$ms.pre-merge-bak" -Force -ErrorAction SilentlyContinue }
        Copy-Item $ds $ms -Force
        if (Test-Path "$dupe\data") { Copy-Item "$dupe\data" "$dir\data" -Recurse -Force -ErrorAction SilentlyContinue }
        Write-Host "    merged newer state ($dn workspaces) from $dupe"
    }
}

$relTag = ""
try { $relTag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -TimeoutSec 6).tag_name } catch {}

$zip = Join-Path $env:TEMP ("sremote-" + [guid]::NewGuid() + ".zip")
try {
    Invoke-RestMethod "https://github.com/$repo/releases/latest/download/sremote-server.zip" -OutFile $zip
} catch {
    Write-Host "    release asset unavailable - falling back to main branch"
    $relTag = "main"
    Invoke-RestMethod "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip
}
$tmp = Join-Path $env:TEMP ("sremote-src-" + [guid]::NewGuid())
Expand-Archive $zip $tmp -Force
$src = Get-ChildItem $tmp -Recurse -Filter server.js | Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
if (-not $src) { throw "server.js not found in downloaded package" }
foreach ($f in 'server.js','package.json','package-lock.json','install.bat','start.bat','README.md','public','agent') {
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

# ---------- 4. tray app + start.cmd + autostart task ---------------------------
# compile the tray host (winexe -> no console window ever, icon + start/stop)
$traySrc = Join-Path $dir 'agent\tray\SremoteTray.cs'
$trayExe = Join-Path $dir 'agent\tray\SremoteTray.exe'
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -ErrorAction SilentlyContinue
if (-not $csc) { $csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" -ErrorAction SilentlyContinue }
if ($csc -and (Test-Path $traySrc)) {
    & $csc.FullName /nologo /target:winexe "/out:$trayExe" /r:System.Drawing.dll /r:System.Windows.Forms.dll $traySrc | Out-Null
    if (Test-Path $trayExe) { Write-Host "    tray app compiled: $trayExe" }
    else { Write-Host "    WARN: tray compile failed (console start.cmd will be used)" }
}

@"
@echo off
cd /d %~dp0
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
if exist "%~dp0agent\tray\SremoteTray.exe" (start "" "%~dp0agent\tray\SremoteTray.exe" & exit /b)
start "" /min node server.js
"@ | Set-Content (Join-Path $dir 'start.cmd') -Encoding ascii

$launch = if (Test-Path $trayExe) { "`"$trayExe`"" } else { "`"$dir\start.cmd`"" }
schtasks /create /f /tn $taskName /tr $launch /sc onlogon /rl limited | Out-Null
if ($LASTEXITCODE -ne 0) {
    # no admin? fall back to per-user Run key (tray menu manages it too)
    try {
        $rk = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $exe2 = if (Test-Path $trayExe) { $trayExe } else { Join-Path $dir 'start.cmd' }
        Set-ItemProperty -Path $rk -Name 'S-remote' -Value ('"' + $exe2 + '"')
        Write-Host "    autostart via HKCU Run (scheduled task needs admin)"
    } catch { Write-Host "    WARN: could not register autostart" }
}

# firewall rule for TCP 2209 - only when elevated; harmless otherwise
net session >$null 2>&1
if ($LASTEXITCODE -eq 0) {
    netsh advfirewall firewall add rule name="S-remote" dir=in action=allow protocol=TCP localport=2209 | Out-Null
}

# ---------- 5. (re)start -------------------------------------------------------
# stop old tray first — a running tray won't auto-revive a killed server,
# and the fresh tray instance below starts the server itself
Get-Process SremoteTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$dir\server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# server launched as "node server.js" (relative) hides its dir from cmdline -
# attribute by port instead: the node process listening on :2209 is ours.
# always do this (not only on update): a stale server from another dir would
# hold the port and make the fresh install look broken
Get-NetTCPConnection -LocalPort 2209 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
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
# ---------- 6. remove duplicate install dirs (fix mode) -------------------------
# the new server is already up in $dir — kill anything still running out of the
# duplicate dir (tray, stray node) so its files unlock, then delete the dir
foreach ($dupe in $fixDupes) {
    if ([IO.Path]::GetFullPath($dupe) -eq [IO.Path]::GetFullPath($dir)) { continue }
    Write-Host "    removing duplicate install: $dupe"
    $esc = [regex]::Escape($dupe.TrimEnd('\'))
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { ($_.CommandLine -match "$esc[\\/]") -or ($_.ExecutablePath -match "$esc[\\/]") } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    try { Remove-Item $dupe -Recurse -Force -ErrorAction Stop
          Write-Host "    removed $dupe" }
    catch { Write-Host "    WARN: could not fully remove $dupe - delete it manually after a reboot" }
}

if ($relTag) { Write-Host "    Install complete — version $relTag" }
Write-Host "    Local:     http://localhost:2209"
Write-Host "    Tailscale: http://<this-machine-tailscale-ip>:2209"
Write-Host "    Dir:       $dir  (autostarts at logon)"
