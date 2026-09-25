# S-remote

Direct remote terminal over **Tailscale** — no relay server, no token, no cloud.
Web UI (xterm.js) + PTY sessions that persist across restarts.

## Requirements

- **Node.js 18+**
- **Tailscale** installed and logged into your tailnet

## Install on another machine

1. Copy this folder (`S-remote`) to the target machine — `node_modules` is
   already included and `node-pty` ships prebuilt binaries for
   Windows/macOS/Linux (x64 + arm64), so no build step is needed.
2. Run:

   ```bash
   node server.js        # or: npm start
   ```

3. Open from any device in the tailnet:

   ```
   http://<machine-tailscale-ip>:2209
   ```

Access is restricted to tailnet IPs (`100.64.0.0/10`) and localhost — anything
else gets 403 before reaching the app.

### First run on Windows

Windows Firewall may prompt to allow `node.exe` to listen — approve it, or add
a rule limited to the Tailscale interface:

```powershell
New-NetFirewallRule -DisplayName "S-remote" -Direction Inbound `
  -Program "C:\Program Files\nodejs\node.exe" -LocalPort 2209 -Action Allow `
  -InterfaceAlias "Tailscale"
```

## Autostart

**Windows (Task Scheduler):**

```powershell
schtasks /create /tn "S-remote" /tr "node C:\path\to\S-remote\server.js" `
  /sc onlogon /rl highest /f
```

Or double-click `start.bat` for a manual start.

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
