# S-remote — architecture map

Read this before exploring; it should save a full pass over the codebase.
Operational notes (build, git, release, BOM) live in `AGENTS.md`.

## What it is

Self-hosted remote terminal: PTYs run on this machine, any browser (or the
Android app) on the Tailscale network attaches over a direct WebSocket.
No relay, no account. Port **2209** (`SREMOTE_PORT`/`PORT` env).

Access control: every HTTP/WS request must come from localhost or the tailnet
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) — see `isAllowedRemote` in server.js.
Everything else gets 403 before reaching handlers.

## Processes

```
browser/Android ──WS :2209──> server.js ──JSONL pipe──> agent/session-host.js ──> node-pty ──> shells
                     ──HTTP :2209──> server.js (REST + static public/)
```

- `server.js` is stateless-ish glue: auth, REST, WS fan-out, workspace persistence.
- `agent/session-host.js` is a **detached daemon** owning the PTYs + scrollback
  buffers. Sessions survive `server.js` restarts. Pipe name is per-install:
  `\\.\pipe\sremote-sessions-<sha1(ROOT)[:10]>` (win) or `data/host.sock`.
- Remote screen: `agent/screen-pro/ScreenPro.exe` (C#, DXGI capture + input
  injection, built on demand by `/api/screen-pro`), legacy
  `agent/screen-agent.ps1`, `agent/tray/SremoteTray.exe` (Windows tray icon).

## Service mode (AnyDesk-style, optional)

`agent/service/SremoteService.exe` runs `server.js` as **SYSTEM** from boot
(Session 0). Since Session 0 can't see user desktops or launch user-context
processes, the broker opens a loopback agent link (`127.0.0.1:2210`, key in
`data/agent.key`) and two kinds of agents connect:

- **User agent** (`agent/user-agent.js`, tray-supervised, per logon session):
  owns `session-host` in-session so PTYs run as the logged-in user; relays
  screen agents' stdio. Pre-login the broker self-spawns a SYSTEM session-host;
  on first user hello it sends `shutdown`, the host persists state, and the
  user agent respawns it — scrollback survives the handover.
- **Console agent** (same file, service-spawned via `CreateProcessAsUser` into
  `WTSGetActiveConsoleSessionId`, `SREMOTE_CONSOLE=1`): runs as SYSTEM *inside*
  the physical console session, which exists even at the logon screen —
  that's how screen capture/input work before login. `screen-agent.ps1`
  re-attaches its thread to `OpenInputDesktop` each op to follow the
  Winlogon→Default transition at login.

Routing in `server.js`: `primaryAgent()` (PTY/session work) prefers a real
user agent; `screenRelayAgent()` (screen/input) prefers the console agent.

## Layout

```
server.js            HTTP + WS + session broker glue (the whole backend)
state.json           persisted: {workspaces[], sessions[] legacy}
data/                host.sock, sessions.json (host), scrollback/, uploads tmp
agent/               session-host.js, screen-pro/ (C# + exe), tray/, screen-agent.ps1
public/              the web UI (served from disk — no build step)
  index.html         both views + all modals; ?v= cache-busting for app.js/style.css
  app.js             ALL client logic for index.html (~2.7k lines, one file, "use strict")
  screen.html/.js    remote-desktop page (separate WS consumer)
  screen.css
  style.css          base theme first ~130 lines, then "GLASS THEME LAYER" :root overrides
  sw.js              pass-through service worker (registered for installability)
  vendor/            vendored xterm.js + addons (fit, search, web-links, unicode11)
android/             native Java app (no AndroidX), gradle + build-apk.bat
install.ps1/.bat     Windows installer; fix-state.ps1 recovery; start.*
docs/                screenshots + assets for README only
temp-upload/         default drop zone for uploads (git-excluded, swept >7d)
```

## Data model

- **workspace** `{id, name, path, lastUsed}` — a project folder. `state.json`.
- **session** `{id, name, shell, cwd, workspace|null, createdAt, exited, clients, lastOut}`
  — `workspace` is a ws id or `null` (standalone). Owned by session-host;
  server.js keeps a mirror `Map`.
- Client treats a session whose `workspace` points at a deleted ws as
  standalone — `sessWs()` in app.js.

## server.js structure (top → bottom)

1. access control (`isAllowedRemote`, `tailscaleIPv4`)
2. persisted state + `saveState`
3. `/api/browse` dir listing helpers, `SHELLS` detection
4. **session broker**: `hostSend`/`onHostMsg` JSONL client, `createSession`,
   `killSession`, `sessionList`, `broadcastSessions`, attach tokens,
   `reattachAll` on reconnect, `activity` tick (lastOut map → all clients)
5. external cmds via `run()` (execFile, bounded): tailscale status, netstat/ss,
   tasklist, git — `apiPeers`, `apiDevports`, `apiGit`, `apiGitDiff`
6. archive helpers (zip/extract via PowerShell/tar), `resolveBase`/`jail`
   (file APIs are jailed to a base: `ws:<id>` → workspace path, `@abs` →
   whole filesystem)
7. screen-share plumbing (legacy PS agent + ScreenPro)
8. HTTP handler → REST table (below), static file server (etag, no-cache)
9. WS `/ws` handler → message switch (below)

### REST endpoints

```
GET  /api/info                hostname, tailscaleIp, home, platform, shells[]
GET  /api/browse?path=        dirs-only listing + drives + quickAccess
POST /api/mkdir               {parent(abs), name}
GET|POST /api/workspaces      list | add {path}
PATCH|DELETE /api/workspaces/:id   rename | remove (sessions become standalone)
GET  /api/files?base=&path=   listing jailed under base (ws:<id> | @abs | abs)
GET  /api/file?base=&path=[&dl=1][&head=1]   file content / download / head
GET  /raw/<base>/<path...>    raw bytes (html preview with relative assets)
GET  /api/dbg                 debug counters
GET  /api/peers               tailscale status --json + /api/info probe per peer
GET  /api/devports            listening TCP ports (+ proc name on Windows)
GET  /api/git?base=           {isRepo, branch, changed}
GET  /api/gitdiff?base=       {stat, diff, truncated}
POST /api/upload?base=&dir=&name=   raw body upload (default dir: temp-upload)
POST /api/fileop              {base, op: rename|delete|mkdir|copy|move|extract|zip, path, name, dest, paths}
GET|POST /api/screen-pro      installed? | build+start ScreenPro.exe
GET|POST /api/sessions        list | create {shell,cwd,cols,rows,workspace,name}
DELETE /api/sessions/:id      kill
POST /api/sessions/:id/input  {data} raw keys | {line} text+Enter → {offset} (log end before the input)
GET  /api/sessions/:id/output?since=&tail=&wait=ms
                              plain-text log (ANSI stripped, 256KB tail) by absolute char offset →
                              {data, since, next, base, truncated, exited}; wait = long-poll ≤60s
```

`GET /remote.md` (`remoteGuide`) — agent onboarding page generated per request
from the Host header (address), hostname, `SHELLS`, workspaces and live session
names: setup, workflow, rules, raw HTTP. Give an agent the IP, it reads this.

Agent API: server.js keeps `s.log {text, base}` per session, fed from every
broker `out`. Sessions older than the server process are seeded lazily from the
broker scrollback (`withLog`, attach with a callback in `pendingAttach`;
exited ones are skipped — attach would respawn them). Client:
`public/cli/sremote.js` (no deps, Node 18+, served at `/cli/sremote.js`) —
`ls/new/send/key/run/read/wait/tail/kill`; `run` appends a shell-specific
done-marker `__SRDONE_<nonce>:<code>` to get the exit code.

### WS protocol (`/ws`, JSON unless noted)

Client → server: `attach{id,cols,rows}` `detach{id}` `in{id,data}` `resize`
`create{shell?,cwd?,cols,rows,workspace?,name?}` `rename{id,name}` `kill{id}`
`list` `screen{...}` `ping{t}`

Server → client: `sessions{list[]}` (full snapshot on every change),
`out{id,data}` (string; binary frames are screen only), `attached{id,exited}`,
`exit{id,code}`, `created{id}` (to the creator; broadcastSessions goes first),
`activity{map:id→lastOut}` (coalesced tick), `pong{t}`, `screen{...}`.

Attach semantics: `attach` adds the ws to `s.clients`; the host replies with
scrollback replay then live output. Detach removes the client; the PTY keeps
running and keeps buffering.

## public/app.js structure (one file, sections marked by `// ----------` banners)

- **state** (top): `sessions[]`, `workspaces[]`, `activeId`, `view`,
  `currentWs` (`undefined`=home, `null`=standalone, id=project),
  `panes:Map(id→{term,fit,el,attached,lastOutAt,idleNotified,title,search})`,
  `splitId`, `splitFocus`, `wantSplitForNew`, `onScreen()`,
  `unreadSess`/`notifiedSess` Sets, `mru`/`seen` in localStorage.
- helpers: `esc`, `hl` (fuzzy-highlight), `fz` fuzzy match, `relTime`,
  `sessWs` (session→ws or null), `sessInView` (sessions of currentWs),
  `inView(id)`, `sessState` (off|bell|busy|new|idle).
- **websocket**: `connect()` + the `onmessage` switch (mirrors protocol above;
  also self-heals `activeId`/`splitId` when sessions vanish).
- **views**: `showView`, `enterWorkspace` (resets split!), `openSession`
  (the universal "go to session" — in-ws → select; foreign + split on →
  guest pane focused; else enterWorkspace), `quickNew`, `goHome`, `applyRoute`
  (`#s=`, `#ws=`, `#screen`, `#fx=` deep links), `popstate` back handling.
- **panes**: `ensurePane` (xterm + fit/search/weblinks/unicode11 + touch
  scroll/long-press-select + jump-to-latest + all key handlers),
  `attach`, `sendSize`, `layoutPanes`, `focusSide`, `swapFocus`,
  `syncWsToActive`, `splitWith`, `newForSplit`, `pickSplit`, `fitVisible`,
  `toggleSplit`, `select`, `closeSession`, `renameSession`.
- **rendering**: `renderAll`, `refreshStates` (cheap in-place dot/time update),
  `renderSessions` (sidebar nav tree — every project, expandable),
  `renderTabs` (in-view tabs + guest tab), `renderHome` (search/continue/
  project cards), `renderMachines`, `renderDevports`, `updateEmpty`.
- **features**: keybar (`KB_KEYS` + `rd.keybar.v1`), typer row (buffered
  input + history), snippets (`rd.snip.<ws>`), notifications (bell/idle,
  `notifySession`/`clearNotify`), copy mode, drag-drop upload, swipe-to-switch,
  palette (`palItems`/`palSplitItems`/`openPalette(mode)`), terminal search
  (SearchAddon), settings modal, files panel (`fpRoot`/`fpPath`/`fpNavigate`),
  file preview (img/video/audio/iframe/md-lite), git diff modal, folder
  picker, full explorer (`fx*`), new-session modal.
- **boot**: `/api/info` → shell options → theme → `loadWorkspaces` →
  `connect()` → ResizeObserver on #terms, virtualKeyboard/visualViewport
  handling.

### Split model (invariant!)

- `activeId` = focused session, **always inside `currentWs`** (sessions of the
  project the chrome describes). `splitId` = the guest pane — **may live in
  ANY project**.
- Clicking the guest pane / its guest tab / "Focus split pane" → `swapFocus()`
  swaps the pair; `syncWsToActive()` re-points `currentWs` (sidebar "cur",
  tabs, files `fpRoot`, title, `snipKey`, `#new-btn-ws`) to the newly focused
  session's project.
- Paths that place a guest session: `toggleSplit` (next in-ws), `pickSplit`
  → `openPalette("split")`, `openSession` foreign while split on (lands
  focused on the guest side), sessMenu "Show in split pane" (unfocused),
  `newForSplit` via "+" and the new-session modal (`wantSplitForNew` flag
  consumed by the `created` message), palette "New terminal — <project>".
- `enterWorkspace`/`goHome` always clear split + `wantSplitForNew`.
- Foreign partner UI: guest tab (`tab guest` + `tab-ws` chip), `on-split`
  marker on its nav row. `onScreen(id)` covers both visible panes for
  seen/unread/bell suppression.

### Web UI conventions

- localStorage keys are `rd.*` (font, theme, shell, files, sidebar, w.side,
  w.files, mru, seen, pins, navopen, keybar.v1, typer.hist, snip.*, hfilter,
  hsort, typebar).
- After editing `app.js`/`style.css`, bump `?v=` in `index.html`.
- `node --check public/app.js` to syntax-verify; static files read per-request.
- State colors: `.st-busy` green pulse, `.st-new` blue, `.st-bell` amber.

## Remote screen

`public/screen.html` + `screen.js` — separate page, own WS. Subscribes via
`screen{op:"sub",pro:true}`; ScreenPro.exe (DXGI capture, built on demand)
streams frames binary over the same WS; input events go back as JSON
`screen{op:"in",...}` with client-side flow control (`_inflight`). Opened as a
new tab in browsers, in-place inside the Android app (`SRemoteApp` UA).

## Android app

`android/` — plain Java, no AndroidX. `MainActivity` (host list) →
`HostActivity` (WebView of the remote UI, `SRemoteApp` UA marker) +
native glue: `Api`, `HostStore`, `Tailscale` (app-to-app intents + CONNECT_VPN /
DISCONNECT_VPN broadcasts to the official app's `IPNReceiver`), `FilesActivity`
(native explorer over `/api/files|fileop|upload`), `GitDiff` (`/api/gitdiff`),
`MonitorService`/`MonitorTile`/`StatusWidget`/`Notify` (session-state
background monitor + quick settings tile + widget), `BootReceiver`,
`SessionSheet`/`SessionItem`, `Detector` (local S-remote discovery),
`OnboardingActivity`, `ReplyReceiver`, `LockGate`, `EventLog`, `StateBus`,
`MiniFileProvider`, `HostDetailActivity` (projects + git + dev servers).
Visual style mirrors the web glass theme via the `Ui` kit (fixed brand palette).
Plan / changelog: `android/PLAN-v2.md` (2.0 + 2.1 sections).

## Install / release

`install.ps1` downloads `releases/latest/download/sremote-server.zip`
(built via `git archive`, see AGENTS.md) → `start.bat`/`start.cmd` →
`node server.js`. Session host auto-spawns on first WS connect.
