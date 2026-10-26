# S-remote — notes for agents

Read `ARCHITECTURE.md` first — full map of server/UI/protocol/state so you don't have to re-derive it.

## Layout
- `server.js` (Node, port 2209) + `agent/` (session broker, screen agents, tray, service) + `public/` (web UI, static, served from disk).
- `android/` — native Android client (Java, no AndroidX). Plan for the 2.0 redesign: `android/PLAN-v2.md`.
- `install.ps1` / `fix-state.ps1` / `elevate.ps1` — Windows installer + recovery, bootstrapped via `irm <raw-url> | iex`. Keep them **pure ASCII, no BOM**: PS 5.1 `iex` doesn't skip U+FEFF so a BOM turns the first `#` line into a "command" (and keep them ASCII-only anyway so `-File` never needs BOM either).
- `install.sh` — Linux installer (headless: terminals only, systemd, `curl | sudo bash`). Keep it LF (`.gitattributes`).

## Service architecture (AnyDesk-style)
- `agent/service/SremoteService.cs` → `SremoteService.exe` — real Windows service (name `SremoteService` = exe filename; sc.exe auto-start + `sc failure` restart actions). Spawns `node server.js` as **SYSTEM** with `SREMOTE_SERVICE=1`, watchdog respawns it, stdout → `data/service.log` (auto-trimmed >1 MB). Extra env overrides: `data/service.env` (`KEY=VALUE` lines, e.g. `SREMOTE_PORT`, `SREMOTE_AGENT_PORT`).
- `agent/user-agent.js` — per-logon-session helper (tray keeps it alive; pid file `data/agent-<user>-<sess>.pid`). Connects JSONL over `127.0.0.1:2210` (`SREMOTE_AGENT_PORT`) authing with `data/agent.key` (installer grants `BUILTIN\Users:R`). Ensures `session-host.js` runs **in-session** (PTYs = user context) and relays screen agents' stdio (Session-0 can't see desktops).
- **Console agent (pre-login screen)**: the service also spawns `user-agent.js` into `WTSGetActiveConsoleSessionId()` as SYSTEM (`CreateProcessAsUser` on a session-adjusted duplicate token, `SREMOTE_CONSOLE=1` + `SREMOTE_SESSION_ID`, pid file `data/agent-console.pid`). The console session exists at the logon screen, so screen capture + input work before anyone signs in. Its env block is built nearly empty by `CreateEnvironmentBlock` — the service injects SystemRoot/PATH/etc itself. Broker routing: PTY/session work prefers a real user agent (`primaryAgent`), screen/input ops prefer the console agent (`screenRelayAgent`). `screen-agent.ps1` re-attaches to the input desktop every op (`OpenInputDesktop`+`SetThreadDesktop`) so it follows Winlogon↔Default transitions.
- Handover: pre-login the broker spawns a SYSTEM `session-host` (terminals work as SYSTEM); when a user agent connects, the host gets `shutdown` (flush+persist) and the agent respawns it in-session — scrollback survives.
- Detection: `IS_SERVICE` = `SREMOTE_SERVICE=1` or `os.userInfo() === "SYSTEM"`. Non-service mode is unchanged (tray spawns node directly; screen/host spawn locally).
- Tray (`agent/tray/SremoteTray.cs`): `sc.exe qc/start/stop SremoteService` when the service exists; supervises `user-agent.js`; falls back to owning `node server.js` when no service.
- csc.exe builds: `/target:exe /r:System.ServiceProcess.dll` (service); `/target:winexe` (tray). Under Git Bash use `-flag` form (bare `/x` gets mangled to paths).

## Web UI
- After editing `public/app.js` or `public/style.css`, bump `?v=` in `public/index.html` (cache busting).
- Syntax check: `node --check public/app.js`. No restart needed — static files are read from disk.

## Android build (Windows, portable toolchain in `%USERPROFILE%\android-dev`)
```
cd android && build-apk.bat
```
(sets JAVA_HOME=`%USERPROFILE%\android-dev\tools\jdk-17.0.20.1+1`, ANDROID_HOME=`%USERPROFILE%\android-dev\sdk`, runs gradle 8.9 `assembleRelease assembleDebug`).
Installed on both dev machines (`C:\Users\User`, `C:\Users\Administrator` — migrated from the old `ADMIN` account); only `User` has the release keystore. `Administrator` also has an emulator (AVD `sremote34`, API 34 x86_64) for smoke tests.
Outputs: `android/app/build/outputs/apk/{release/app-release.apk,debug/app-debug.apk}`.
Release signing via `android/keystore.properties` (never print/commit secrets). Verify:
`%USERPROFILE%\android-dev\sdk\build-tools\<ver>\apksigner.bat verify --print-certs app-release.apk` → `CN=S-remote`.

Detector unit test (no Android needed): compile `Detector.java` + a test `main` with the portable `javac` into a temp dir and run with `java`; delete the temp test afterwards.

## Git / release
- Commit identity: `git -c user.name="thsangyk-oss" -c user.email="thsangyk-oss@users.noreply.github.com" commit ...`
- GitHub token: from git credential manager (`printf 'protocol=https\nhost=github.com\n\n' | git credential fill`) — never echo it.
- Release body JSON must be written as UTF-8 by node (curl on Windows mangles non-ASCII), then `POST /repos/thsangyk-oss/sremote/releases`, upload assets to `uploads.github.com/.../assets?name=...`.
- Every release MUST include `sremote-server.zip` (installer downloads `releases/latest/download/sremote-server.zip`). Build it with
  `git archive HEAD server.js package.json package-lock.json install.ps1 install.sh install.bat start.bat start.cmd fix-state.ps1 README.md ARCHITECTURE.md public agent -o temp-upload/sremote-server.zip`
  (git archive excludes locally compiled exes).
