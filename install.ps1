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
# %LOCALAPPDATA% - hiding workspaces (state.json) and live sessions (broker).
# Instead of returning the first match we collect EVERY dir that is an install;
# if several exist we ask the user: fresh install, or fix + install into the
# original dir (re-attaches sessions, merges state, stops the duplicate).
#
# SAFETY: this script never deletes a user folder. A source checkout, fork or
# copy of the project looks exactly like an install, so a dir found only by
# scanning the disk must carry the marker file every install gets (or be the
# installer's own default dir); git checkouts are never picked up by a scan.
$marker = '.sremote-install'
$script:runningRoot    = $null   # dir the :2209 server reports (api/info.root)
$script:liveBrokerDir  = $null   # dir whose session-host.js broker is alive
$candSet = [ordered]@{}

function Test-BroadDir($d) {
    # a stray server.js at a broad location must never make it an "install dir" -
    # choosing it later would mass-kill processes or delete user folders
    try { $d = [IO.Path]::GetFullPath($d).TrimEnd('\') } catch { return $true }
    $broad = @($env:SystemDrive.TrimEnd('\'), "$env:SystemDrive\Users", $env:USERPROFILE.TrimEnd('\'),
               $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:SystemRoot,
               "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Downloads")
    return ($broad -contains $d)
}
# -Scan = found by looking around the disk (no running/registered S-remote points
# at it): only accepted with the install marker, or as the installer's default dir
function Add-InstallCandidate([string]$d, [switch]$Scan) {
    if (-not $d) { return }
    try {
        # an S-remote install always has server.js AND our payload markers -
        # a random node project with its own server.js must never qualify
        if (-not (Test-Path (Join-Path $d 'server.js'))) { return }
        $ours = (Test-Path (Join-Path $d 'public\app.js')) -or
                (Test-Path (Join-Path $d 'agent\session-host.js')) -or
                (Test-Path (Join-Path $d 'install.ps1'))
        if (-not $ours) { return }
        $p = [IO.Path]::GetFullPath($d).TrimEnd('\')
        if (Test-BroadDir $p) { return }
        if ($Scan) {
            if (Test-Path (Join-Path $p '.git')) { return }          # someone's checkout of the source
            $isDefault = $p -match '\\AppData\\Local\\S-remote$'
            if (-not $isDefault -and -not (Test-Path (Join-Path $p $marker))) { return }
        }
        if (-not $candSet.Contains($p)) { $candSet[$p] = $true }
    } catch {}
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
    # "node server.js" (relative) hides its dir - its parent is the tray exe,
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

# helper: first absolute path inside a raw command/action string
function Get-PathFromCmd([string]$raw) {
    if (-not $raw) { return $null }
    $raw = [Environment]::ExpandEnvironmentVariables($raw)   # %LOCALAPPDATA% etc.
    if ($raw -match '"([A-Za-z]:[\\/][^"]+)"') { return $Matches[1] }
    if ($raw -match '([A-Za-z]:[\\/][^\s"'']+)') { return $Matches[1] }
    return $null
}
function Add-ExeParent($m) {
    if (-not $m) { return }
    $d = Split-Path $m -Parent
    Add-InstallCandidate $d                                            # <dir>\start.cmd
    Add-InstallCandidate (Split-Path (Split-Path $d -Parent) -Parent)  # <dir>\agent\tray\*.exe
}

# d) scheduled task actions -> Execute AND Arguments (cmd /c "D:\x\start.cmd")
try { foreach ($a in (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).Actions) {
          Add-ExeParent (Get-PathFromCmd $a.Execute)
          Add-ExeParent (Get-PathFromCmd $a.Arguments)
      } } catch {}

# e) autostart Run keys -> same shapes, %env% vars expanded, extra args ignored
foreach ($rk in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
                'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') {
    try { $v = (Get-ItemProperty $rk -Name 'S-remote' -ErrorAction Stop).'S-remote'
          Add-ExeParent (Get-PathFromCmd $v) } catch {}
}

# f) every top-level dir on every drive, plus one level deeper for dirs whose
#    name mentions "remote" (covers C:\sremote, D:\tools\sremote, D:\x\my-remote)
#    - marker required (see SAFETY above)
foreach ($drv in (Get-PSDrive -PSProvider FileSystem)) {
    Get-ChildItem $drv.Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        Add-InstallCandidate $_.FullName -Scan
        Get-ChildItem $_.FullName -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'remote' } | ForEach-Object { Add-InstallCandidate $_.FullName -Scan }
    }
}

# g) well-known spots - current user AND every profile under <sysdrive>\Users
#    (the install may belong to another admin account on the same machine)
$well = @("$env:LOCALAPPDATA\S-remote", "$env:USERPROFILE\S-remote", "$env:USERPROFILE\sremote",
          "$env:USERPROFILE\Desktop\S-remote", "$env:USERPROFILE\Documents\S-remote", "$env:ProgramData\S-remote")
Get-ChildItem "$env:SystemDrive\Users" -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $u = $_.FullName
    $well += "$u\AppData\Local\S-remote", "$u\S-remote", "$u\sremote", "$u\Desktop\S-remote", "$u\Documents\S-remote"
}
foreach ($d in $well) { Add-InstallCandidate $d -Scan }

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
    Write-Host "        (keeps workspaces, re-attaches live sessions, stops the other copies;"
    Write-Host "         their folders are left on disk - delete them yourself if unneeded)"
    $choice = $env:SREMOTE_MODE
    if (-not $choice) { try { $choice = Read-Host "    Choice [1/2, default 2]" } catch { $choice = '2' } }
    if ($choice -eq '1' -or $choice -match '^(fresh|new)$') { $dir = $freshDir }
    else { $dir = $primary; $fixDupes = @($cands | Where-Object { $_ -ne $primary }) }
}

if ($env:SREMOTE_PROBE_ONLY) {
    Write-Host "==> probe only"
    foreach ($d in $cands) { Write-Host ("    cand: {0}  ({1})" -f $d, (Get-DirInfo $d)) }
    Write-Host "    chosen dir: $dir"
    Write-Host "    fixDupes:   $($fixDupes -join '; ')  (stopped, never deleted)"
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
    if (Test-Path "$dir\node\node.exe") { Remove-Item "$dir\node" -Recurse -Force }   # only our old portable node
    elseif (Test-Path "$dir\node") { throw "$dir\node exists and is not a portable Node - refusing to replace it" }
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
# marker: lets later installers recognise this dir as an install (never a user project)
try { Set-Content (Join-Path $dir $marker) "S-remote install dir ($relTag). Used by install.ps1 to recognise this folder - keep it." -Encoding ascii } catch {}

# ---------- 3. dependencies ----------------------------------------------------
Push-Location $dir
try {
    & npm.cmd install --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally { Pop-Location }

# ---------- 4. tray app + start.cmd + autostart task ---------------------------
# compile the tray host (winexe -> no console window ever, icon + start/stop)
# stop the exes' owners BEFORE compiling: a running tray locks SremoteTray.exe
# and a running service locks SremoteService.exe - csc then fails CS0016 while
# the stale binary stays, silently leaving old code in place (this actually
# broke a machine: Oct tray had no user-agent -> all terminals ran as SYSTEM)
try { sc.exe query SremoteService >$null 2>&1; if ($LASTEXITCODE -eq 0) { sc.exe stop SremoteService >$null 2>&1; Start-Sleep -Milliseconds 800 } } catch {}
Get-Process SremoteTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
function Build-Exe($src, $out, $target, $refs) {
    if (-not (Test-Path $src)) { return $false }
    $r = & $csc.FullName /nologo "/target:$target" "/out:$out" $refs $src 2>&1
    if ($LASTEXITCODE -ne 0) {
        # exe still locked (e.g. running in another session) - rename it away and retry once
        Rename-Item $out "$out.old" -Force -ErrorAction SilentlyContinue
        $r = & $csc.FullName /nologo "/target:$target" "/out:$out" $refs $src 2>&1
    }
    if ($LASTEXITCODE -eq 0 -and (Test-Path $out)) { Write-Host "    compiled: $out"; return $true }
    Write-Host "    WARN: compile failed for $out"; $r | Select-Object -First 5 | ForEach-Object { Write-Host "      $_" }
    return $false
}
$traySrc = Join-Path $dir 'agent\tray\SremoteTray.cs'
$trayExe = Join-Path $dir 'agent\tray\SremoteTray.exe'
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -ErrorAction SilentlyContinue
if (-not $csc) { $csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" -ErrorAction SilentlyContinue }
if ($csc) {
    if (-not (Build-Exe $traySrc $trayExe 'winexe' @('/r:System.Drawing.dll','/r:System.Windows.Forms.dll'))) {
        Write-Host "         (console start.cmd will be used)"
    }
}

# ---------- 4b. SYSTEM service (AnyDesk-style broker) --------------------------
# a real Windows service keeps server.js alive from boot, before any logon;
# once a user signs in, the tray's per-session user agent supplies terminals +
# screen inside that session (a Session-0 service can't touch the desktop)
$svcSrc = Join-Path $dir 'agent\service\SremoteService.cs'
$svcExe = Join-Path $dir 'agent\service\SremoteService.exe'
if ($csc -and -not (Build-Exe $svcSrc $svcExe 'exe' @('/r:System.ServiceProcess.dll'))) {
    Write-Host "         (logon task will start the server instead)"
}
$svcOk = $false
if (Test-Path $svcExe) {
    try { net session >$null 2>&1 } catch {}
    if ($LASTEXITCODE -eq 0) {
        $exists = $false
        try { sc.exe qc SremoteService >$null 2>&1; $exists = ($LASTEXITCODE -eq 0) } catch {}
        if ($exists) {
            sc.exe stop SremoteService >$null 2>&1
            sc.exe config SremoteService binPath= "`"$svcExe`"" start= auto >$null 2>&1
        } else {
            sc.exe create SremoteService binPath= "`"$svcExe`"" start= auto DisplayName= "S-remote Broker" >$null 2>&1
        }
        sc.exe description SremoteService "S-remote broker - remote terminal/screen over Tailscale (starts at boot)" >$null 2>&1
        sc.exe failure SremoteService reset= 86400 actions= restart/3000/restart/5000/restart/10000 >$null 2>&1
        $svcOk = $true
        Write-Host "    Windows service registered: SremoteService (auto-start + auto-restart)"
    } else {
        Write-Host "    no admin - service skipped, server starts at logon via the tray"
    }
}

# agent.key - shared secret the per-session user agent sends the broker on
# 127.0.0.1:2210. Pre-create it readable by local Users so agents on any
# account can authenticate (localhost is already the trust boundary).
$dataDir = Join-Path $dir 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$keyFile = Join-Path $dataDir 'agent.key'
if (-not (Test-Path $keyFile)) {
    $kb = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($kb)
    Set-Content $keyFile ([BitConverter]::ToString($kb) -replace '-','').ToLower() -Encoding ascii -NoNewline
}
try { icacls $keyFile /grant '*S-1-5-32-545:(R)' >$null 2>&1 } catch {}

@"
@echo off
cd /d %~dp0
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
sc qc SremoteService >nul 2>&1 && (net start SremoteService >nul 2>&1 & exit /b)
if exist "%~dp0agent\tray\SremoteTray.exe" (start "" "%~dp0agent\tray\SremoteTray.exe" & exit /b)
start "" /min node server.js
"@ | Set-Content (Join-Path $dir 'start.cmd') -Encoding ascii

$launch = if (Test-Path $trayExe) { "`"$trayExe`"" } else { "`"$dir\start.cmd`"" }
# prefer an elevated task: tray -> server -> session broker -> PTYs all inherit
# the admin token, so every terminal session gets admin rights without UAC.
# creating a "highest" task needs an elevated shell; degrade gracefully.
# NOTE: native stderr merged via 2>&1 becomes a terminating error under
# $ErrorActionPreference='Stop' - wrap every may-fail native call in try/catch.
$elevTask = $false
if (-not $env:SREMOTE_LIMITED) {
    try { schtasks /create /f /tn $taskName /tr $launch /sc onlogon /rl highest >$null 2>&1 } catch {}
    $elevTask = ($LASTEXITCODE -eq 0)
}
if (-not $elevTask) {
    try { schtasks /create /f /tn $taskName /tr $launch /sc onlogon /rl limited >$null 2>&1 } catch {}
}
if ($elevTask) { Write-Host "    autostart task runs elevated - sessions get admin rights" }
if (-not $elevTask -and $LASTEXITCODE -ne 0) {
    # no admin? fall back to per-user Run key (tray menu manages it too)
    try {
        $rk = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $exe2 = if (Test-Path $trayExe) { $trayExe } else { Join-Path $dir 'start.cmd' }
        Set-ItemProperty -Path $rk -Name 'S-remote' -Value ('"' + $exe2 + '"')
        Write-Host "    autostart via HKCU Run (scheduled task needs admin)"
    } catch { Write-Host "    WARN: could not register autostart" }
}

# firewall rule for TCP 2209 - only when elevated; harmless otherwise.
# net session exits 1 with "Access is denied" off an admin shell - that stderr
# would abort the whole script if merged, so it stays inside try/catch.
try { net session >$null 2>&1 } catch {}
if ($LASTEXITCODE -eq 0) {
    netsh advfirewall firewall add rule name="S-remote" dir=in action=allow protocol=TCP localport=2209 | Out-Null
}

# ---------- 5. (re)start -------------------------------------------------------
# stop the service first - its auto-restart would relaunch the node we kill below
try { sc.exe query SremoteService >$null 2>&1; if ($LASTEXITCODE -eq 0) { sc.exe stop SremoteService >$null 2>&1; Start-Sleep -Milliseconds 800 } } catch {}
# stop old tray first - a running tray won't auto-revive a killed server,
# and the fresh tray instance below starts the server itself
Get-Process SremoteTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$escDir = [regex]::Escape($dir)
Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "$escDir[\\/]server\.js" } |
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
if ($svcOk) { sc.exe start SremoteService >$null 2>&1 }
try { schtasks /run /tn $taskName >$null 2>&1 } catch {}
if (-not $svcOk -and $LASTEXITCODE -ne 0) { Start-Process -FilePath "$dir\start.cmd" -WindowStyle Hidden }
Start-Sleep -Seconds 2

try {
    $info = Invoke-RestMethod "http://localhost:2209/api/info" -TimeoutSec 4
    Write-Host ""
    Write-Host "OK - S-remote $(if($update){'updated'}else{'installed'}) on $($info.hostname)"
} catch {
    Write-Host ""
    Write-Host "OK - S-remote $(if($update){'updated'}else{'installed'}) (server starting...)"
}
# ---------- 6. retire duplicate installs (fix mode) -----------------------------
# Stop the S-remote processes running FROM a duplicate dir - an exe inside the
# dir or our own scripts run from it - plus their descendant tree (PTY shells
# under its broker). Anything merely mentioning the path (editors with a file
# open there, terminals cd'd into it) is left alone. The folder itself is NEVER
# deleted: a wrong guess must not be able to destroy someone's files.
$leftOver = @()
foreach ($dupe in $fixDupes) {
    if ([IO.Path]::GetFullPath($dupe) -eq [IO.Path]::GetFullPath($dir)) { continue }
    if (Test-BroadDir $dupe) { continue }
    Write-Host "    stopping duplicate install: $dupe"
    $esc = [regex]::Escape($dupe.TrimEnd('\'))
    $ourFiles = '(server\.js|agent[\\/][^"\\'']*\.(js|exe|ps1)|start\.(cmd|bat)|SremoteTray\.exe|ScreenPro\.exe)'
    $procs  = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $byPpid = @{}
    foreach ($p in $procs) { $byPpid[$p.ParentProcessId] += @($p.ProcessId) }
    $kill = @{}; $queue = New-Object System.Collections.Queue
    foreach ($p in $procs) {
        $seed = ($p.ExecutablePath -and $p.ExecutablePath -match "^$esc[\\/](node|agent)[\\/]") -or
                ($p.CommandLine -and $p.CommandLine -match "$esc[\\/]$ourFiles")
        if ($seed -and -not $kill.ContainsKey($p.ProcessId)) { $kill[$p.ProcessId] = $true; $queue.Enqueue($p.ProcessId) }
    }
    while ($queue.Count -gt 0) {
        $ppid = $queue.Dequeue()
        foreach ($c in @($byPpid[$ppid])) {
            if ($c -and -not $kill.ContainsKey($c)) { $kill[$c] = $true; $queue.Enqueue($c) }
        }
    }
    foreach ($k in $kill.Keys) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue }
    $leftOver += $dupe
}
if ($leftOver.Count) {
    Write-Host ""
    Write-Host "    Other S-remote copies were stopped but NOT deleted:"
    foreach ($d in $leftOver) { Write-Host "       $d" }
    Write-Host "    Check them and delete manually if you don't need them."
}

if ($relTag) { Write-Host "    Install complete - version $relTag" }
Write-Host "    Local:     http://localhost:2209"
$tsIp = ""
try { $tsIp = ((tailscale ip -4) 2>$null | Select-Object -First 1).Trim() } catch {}
if (-not $tsIp) { $tsIp = "<this-machine-tailscale-ip>" }
Write-Host "    Tailscale: http://${tsIp}:2209"
Write-Host "    Agents:    http://${tsIp}:2209/remote.md  (give this URL to an AI agent on another machine)"
Write-Host "    Dir:       $dir  (autostarts at logon)"
