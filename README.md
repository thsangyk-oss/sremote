# S-remote

Direct remote terminal over **Tailscale** — no relay server, no token, no cloud.
Web UI (xterm.js) + PTY sessions that persist across restarts.

## Requirements

- **Node.js 18+**
- **Tailscale** installed and logged into your tailnet

## Install on another machine

**Windows (packaged release):**

1. Download `S-remote-v1.0.0-win-x64.7z` from
   [GitHub Releases](https://github.com/thsangyk-oss/sremote/releases) and
   extract it — `node_modules` is included and `node-pty` ships prebuilt
   binaries for Windows/macOS/Linux (x64 + arm64), so no build step is needed.
2. Either:
   - `install.bat` — register auto-start at logon (Task Scheduler), add an
     inbound firewall rule for TCP 2209 when run elevated, and start now; or
   - `start.bat` — manual one-off start (equivalent to `node server.js`).
3. Open from any device in the tailnet:

   ```
   http://<machine-tailscale-ip>:2209
   ```

**From source (any OS):** clone/copy this folder and run `node server.js`
(`npm install` first if `node_modules` is absent — `node-pty` needs a
prebuilt binary for your platform).

Access is restricted to tailnet IPs (`100.64.0.0/10`) and localhost — anything
else gets 403 before reaching the app.

### First run on Windows

`install.bat` adds the firewall rule automatically when elevated. To add it
manually, limited to the Tailscale interface:

```powershell
New-NetFirewallRule -DisplayName "S-remote" -Direction Inbound `
  -Program "C:\Program Files\nodejs\node.exe" -LocalPort 2209 -Action Allow `
  -InterfaceAlias "Tailscale"
```

## Autostart

**Windows:** `install.bat` sets up Task Scheduler at logon (see above).
Equivalent manual command:

```powershell
schtasks /create /tn "S-remote" /tr "node C:\path\to\S-remote\server.js" `
  /sc onlogon /rl highest /f
```

**Linux (systemd):**

```ini
[Unit]
Description=S-remote
After=network.target tailscaled.service

[Service]
ExecStart=/usr/bin/node /opt/S-remote/server.js
Restart=always
User=you

[Install]
WantedBy=multi-user.target
```

**macOS (launchd):** create `~/Library/LaunchAgents/com.S-remote.plist`
with a `KeepAlive` ProgramArguments entry pointing at `server.js`.

## Platform notes

- **Windows:** shells are `powershell` / `cmd` / `pwsh`; the folder picker
  scans drives `A:`–`Z:`.
- **Linux/macOS:** shells are detected from `$SHELL` plus `/bin/bash`,
  `/usr/bin/zsh`, `/bin/zsh`, `/bin/sh` (and `pwsh` if on PATH); the folder
  picker lists `/` and `~` instead of drives.

## HTTP API

Base path for file/git endpoints is `base=` — either `ws:<workspace-id>` or an
absolute directory. All paths are jailed under the base.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/info` | Host info: hostname, tailscale IP, available shells |
| GET | `/api/browse?path=` | Dir listing for the folder picker (drives when empty) |
| POST | `/api/mkdir` | `{parent, name}` — create directory |
| GET/POST | `/api/workspaces` | List / create workspace `{path, name}` |
| PATCH/DELETE | `/api/workspaces/:id` | Rename `{name}` / remove workspace |
| GET | `/api/files?base=&path=` | List directory under base |
| GET | `/api/file?base=&path=` | Read file (`&dl=1` attachment, `&head=1` first 512 KB) |
| POST | `/api/upload?base=&name=&dir=` | Raw-body upload into `<base>/<dir>` (default `temp-upload`) |
| GET/POST | `/api/sessions` | List / create PTY session `{shell, cwd, workspace, name}` |
| DELETE | `/api/sessions/:id` | Kill session |
| GET | `/api/peers` | Tailnet peers + probe of their S-remote instance |
| GET | `/api/devports` | Listening TCP ports + owning process name |
| GET | `/api/git?base=` | `{isRepo, branch, changed}` for a base dir |
| GET | `/api/gitdiff?base=` | `{stat, diff, truncated}` vs `HEAD` (diff capped ~256 KB) |
| WS | `/ws` | Terminal I/O: `attach` / `in` / `out` / `resize` / `create` / `rename` / `kill` |

Uploads that land in `<base>/temp-upload/` are added to `.git/info/exclude`
when the base is a git repo, and files there are swept after 7 days.

## Files

| Path | Purpose |
|---|---|
| `server.js` | HTTP + WS + PTY host (single file) |
| `public/` | Web UI — home, terminal tabs, file explorer |
| `state.json` | Persisted workspaces + session records (auto-created) |
| `data/scrollback/` | Per-session scrollback buffers (auto-created) |

## Architecture

```
client browser ──Tailscale WireGuard──> server.js :2209 ──ConPTY──> shell
```

No signaling, no TURN, no tunnel. Pairing = being on the same tailnet.
