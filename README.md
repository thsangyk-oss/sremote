# S-remote

Direct remote terminal over **Tailscale** — no relay server, no token, no cloud.
Web UI (xterm.js) + PTY sessions that persist across restarts.

## Requirements

- **Node.js 18+**
- **Tailscale** installed and logged into your tailnet

## Install / update (Windows)

One command in PowerShell — installs or updates in place, keeping
`state.json` and `data/`:

```powershell
irm https://raw.githubusercontent.com/thsangyk-oss/sremote/main/install.ps1 | iex
```

The script auto-detects an existing install (running server, scheduled
task, well-known dirs), downloads `sremote-server.zip` from the latest
[release](https://github.com/thsangyk-oss/sremote/releases), installs
Node.js portable if missing, runs `npm install --omit=dev`, registers a
`S-remote` scheduled task for autostart, and starts the server.
Install dir defaults to `%LOCALAPPDATA%\S-remote` — override with
`$env:SREMOTE_DIR`, skip the overwrite prompt with `$env:SREMOTE_YES=1`.

Then open from any device in the tailnet:

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

**Windows:** the `irm` installer registers the `S-remote` task
automatically. Equivalent manual command:

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

## Sessions survive server restarts

PTYs are owned by `agent/session-host.js` — a detached broker daemon the
server spawns on demand and talks to over a per-install named pipe
(`\\.\pipe\sremote-sessions-*`) / unix socket (`data/host.sock`).
Restarting or updating `server.js` only drops the WebSocket layer; shells
and everything running inside them (dev servers, agents, builds) keep
running, and scrollback buffers stay resident. Broker crash → server
respawns it; sessions restore from `data/sessions.json` +
`data/scrollback/` (respawned shells — same as the old restart path).

## Remote screen (Windows)

The 🖥 button opens a live view of the host desktop. Tap = left click,
long-press or the **R-clk** button = right click, drag = mouse drag,
two-finger swipe / wheel = scroll, **⌨** = type text and keys
(Esc / Tab / Win-menu shortcuts).

Frames are JPEG captures pushed over `/ws` (`type:"screen"`) by a
PowerShell agent (`agent/screen-agent.ps1`, GDI+ `CopyFromScreen` +
`SendKeys`/`mouse_event` for input — no dependencies). The agent is
spawned on first subscriber and killed 30 s after the last one leaves;
access stays tailnet/localhost-only like everything else. ~5 fps at
your viewport width is the practical rate — enough to watch and click
GUI apps, not a video streamer. UAC/secure-desktop prompts can't be
captured or clicked (Windows security boundary).

### Pro mode

The **PRO** toggle in the screen window switches to a native push-mode
agent (`agent/screen-pro/ScreenPro.cs`). On first use it offers to
install the extension: the host compiles the C# source locally with the
`csc.exe` that ships with .NET Framework — **no download, ~20 KB exe**.

- **DXGI Desktop Duplication** (GPU-side, event-driven): frames are
  pushed only when the screen actually changes — idle desktop ≈ zero
  traffic, changes appear instantly. Falls back to GDI polling when
  duplication isn't available (multi-monitor: dxgi covers the primary
  display, bitblt covers the full virtual screen).
- **64 px tile diffing**: only changed tiles are JPEG-encoded and sent
  as one binary ws frame — ~1 KB per typical update vs ~50 KB full JPEG.
- Binary ws transport (no base64), cursor drawn into each frame, same
  input path. Practical rate ~15 fps, API: same `type:"screen"` ops with
  `pro:true`; frames arrive as binary `ws` messages instead of JSON.
- `GET /api/screen-pro` → install status, `POST /api/screen-pro` →
  compile `ScreenPro.cs` → `ScreenPro.exe`. The exe is gitignored;
  reinstall is a one-click action per host.
- If DXGI returns all-black frames (driver quirk), the agent detects it
  and falls back to GDI capture automatically — the full virtual screen
  is then streamed via the same tile pipeline.

**Pro control (AnyDesk/RustDesk-style):**

- **Real keyboard**: the canvas captures `keydown`/`keyup` → `SendInput`
  with true key down/up — holding keys, modifier combos, F-keys, Win key
  all work. Focus the canvas (tap/click it) to capture keys; clicking
  outside releases them.
- **Unicode typing**: `type` op uses `KEYEVENTF_UNICODE` — Vietnamese
  and non-Latin input work, unlike SendKeys.
- **Clipboard sync**: host clipboard changes are pushed to the client
  automatically; `Ctrl+V` on the canvas (or the ⧉Paste button) sets the
  host clipboard first, then pastes — ordered over the same channel.
- **Mouse**: left/middle/right/X1/X2 buttons — right-click and the
  context menu work directly on the canvas, aux buttons via `auxclick`.
- **Shortcut buttons** in the ⌨ panel: Alt+Tab, Alt+F4, Task Manager,
  Win, Win+D, Win+E, PrtSc. `Ctrl+Alt+Del` is not possible — the secure
  attention sequence requires a Windows service (same limit RustDesk has
  without its service).
- **⛔ button**: `BlockInput` on the host — freezes ALL input (local and
  injected); remote becomes view-only until toggled off. Auto-releases
  when the session/agent stops.
- **⛶ fullscreen** toggle.

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
| WS | `/ws` | Terminal I/O: `attach` / `in` / `out` / `resize` / `create` / `rename` / `kill`; screen share: `type:"screen"` `sub`/`unsub`/`shot`/`click`/`down`/`up`/`move`/`scroll`/`type`/`key` |

Uploads that land in `<base>/temp-upload/` are added to `.git/info/exclude`
when the base is a git repo, and files there are swept after 7 days.

## Files

| Path | Purpose |
|---|---|
| `server.js` | HTTP + WS + PTY host (single file) |
| `public/` | Web UI — home, terminal tabs, file explorer, remote screen |
| `agent/screen-agent.ps1` | Windows screen capture + input agent (spawned on demand) |
| `agent/session-host.js` | Session broker daemon — owns PTYs + scrollback across server restarts |
| `state.json` | Persisted workspaces + session records (auto-created) |
| `data/scrollback/` | Per-session scrollback buffers (auto-created) |

## Architecture

```
client browser ──Tailscale WireGuard──> server.js :2209 ──pipe──> session-host ──ConPTY──> shell
                                        (frontend; restartable)      (broker; outlives server)
```

No signaling, no TURN, no tunnel. Pairing = being on the same tailnet.
