// S-remote — direct remote terminal over Tailscale (no relay)
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const { spawn, execFile, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || process.env.SREMOTE_PORT || 2209);
const IS_WIN = process.platform === "win32";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const STATE_FILE = path.join(ROOT, "state.json");
const DATA_DIR = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- access control: tailnet + localhost only ----------
function tailscaleIPv4() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || [])
      if (a.family === "IPv4" && isTailscaleV4(a.address)) return a.address;
  return null;
}
function isTailscaleV4(ip) {
  const p = ip.split(".").map(Number);
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127; // 100.64.0.0/10 CGNAT
}
function isAllowedRemote(addr) {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (isTailscaleV4(ip)) return true;
  if (ip.startsWith("fd7a:115c:a1e0:")) return true; // tailnet ULA
  return false;
}


// ---------- persisted state (workspaces + session history) ----------
let state = { workspaces: [], sessions: [] };
try { state = { workspaces: [], sessions: [], ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}
let wsSeq = 0;
function workspaceById(id) { return state.workspaces.find((w) => w.id === id); }



// ---------- directory browse ----------
function listDrives() {
  if (!IS_WIN) {
    const d = [{ name: "/", path: "/", drive: true }];
    if (fs.existsSync(os.homedir())) d.push({ name: "~", path: os.homedir() });
    return d;
  }
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ":\\";
    try { fs.accessSync(d); drives.push({ name: d, path: d, drive: true }); } catch {}
  }
  return drives;
}
function quickAccess() {
  const home = os.homedir();
  return [
    { name: "Home", path: home, quick: true },
    { name: "Desktop", path: path.join(home, "Desktop"), quick: true },
    { name: "Documents", path: path.join(home, "Documents"), quick: true },
    { name: "Downloads", path: path.join(home, "Downloads"), quick: true },
  ].filter((q) => fs.existsSync(q.path));
}
function browseDir(p) {
  if (!p) return { path: "", parent: null, items: listDrives(), quickAccess: quickAccess() };
  const dir = path.resolve(p);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    items.push({ name: e.name, path: full });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? "" : parent,
    items,
    quickAccess: quickAccess(),
  };
}

// ---------- shell profiles ----------
const SHELLS = IS_WIN
  ? {
      powershell: { path: "powershell.exe", args: ["-NoLogo"] },
      cmd: { path: "cmd.exe", args: [] },
      pwsh: { path: "pwsh.exe", args: ["-NoLogo"] },
    }
  : (() => {
      const sh = {};
      const add = (p) => {
        try { fs.accessSync(p, fs.constants.X_OK); sh[path.basename(p)] = { path: p, args: [] }; } catch {}
      };
      if (process.env.SHELL) add(process.env.SHELL);
      for (const p of ["/bin/bash", "/usr/bin/zsh", "/bin/zsh", "/bin/sh"]) add(p);
      if (!sh.pwsh) for (const d of (process.env.PATH || "").split(path.delimiter)) {
        const p = path.join(d, "pwsh");
        try { fs.accessSync(p, fs.constants.X_OK); sh.pwsh = { path: p, args: ["-NoLogo"] }; break; } catch {}
      }
      return sh;
    })();

// ---------- service mode: SYSTEM broker + per-session user agents ----------
// Installed as a Windows service (agent/service), the broker is up from boot
// before anyone logs on. A Session-0 service can't see user desktops or
// spawn user-context shells, so agent/user-agent.js (started per logon
// session by the tray) bridges those over a loopback link:
//   screen agents  -> spawned in-session, stdin/stdout relayed here
//   session host   -> the agent spawns it in-session; until a user signs in
//                     we spawn it ourselves so pre-login SYSTEM shells work,
//                     then hand the pipe over (sessions keep their scrollback)
// Link auth: shared key at data/agent.key (installer grants Users:R).
const IS_SERVICE = IS_WIN && (process.env.SREMOTE_SERVICE === "1" ||
  (() => { try { return os.userInfo().username.toUpperCase() === "SYSTEM"; } catch { return false; } })());
const AGENT_PORT = Number(process.env.SREMOTE_AGENT_PORT || 2210);
const AGENT_KEY_FILE = path.join(DATA_DIR, "agent.key");
let agentKey = "";
const agents = new Map();   // "user|sess" -> {sock,user,sess,sessId,console,procs:Map}
let hostUser = null;        // user that owns the live session host

// for PTYs/session-host ownership prefer a REAL user agent (correct context);
// the SYSTEM console agent is just a screen/input relay
function primaryAgent() {
  let pick = null, fallback = null;
  for (const a of agents.values()) {
    if (!a.console && a.user !== "SYSTEM") pick = a;
    else fallback = a;
  }
  return pick || fallback;
}
// screen/input ops prefer the agent sitting in the physical console session —
// it sees whatever is actually displayed, including the logon screen
function screenRelayAgent() {
  for (const a of agents.values()) if (a.console) return a;
  return primaryAgent();
}
function agentSend(a, o) { if (a && a.sock.writable) a.sock.write(JSON.stringify(o) + "\n"); }

function agentListen() {
  try { agentKey = fs.readFileSync(AGENT_KEY_FILE, "utf8").trim(); } catch {}
  if (!/^[0-9a-f]{32,}$/i.test(agentKey)) {
    try { fs.writeFileSync(AGENT_KEY_FILE, crypto.randomBytes(24).toString("hex"), { flag: "wx" }); } catch {}
    try { agentKey = fs.readFileSync(AGENT_KEY_FILE, "utf8").trim(); } catch {}
  }
  const srv = net.createServer((sock) => {
    let a = null, buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!a) {   // first frame must be an authed hello
          if (m.op !== "hello" || !agentKey || m.key !== agentKey) { sock.destroy(); return; }
          a = { sock, user: String(m.user || "?"), sess: String(m.sess || ""),
                sessId: m.sessId ?? null, console: !!m.console,
                procs: new Map(), id: `${m.user}|${m.console ? "con" : ((m.sessId ?? m.sess) || m.pid || ++seq)}` };
          const old = agents.get(a.id);   // duplicate agent in the same session
          if (old) { for (const [, c] of old.procs) c.emit("exit"); try { old.sock.destroy(); } catch {} }
          agents.set(a.id, a);
          agentSend(a, { op: "hello-ok" });
          agentSend(a, { op: "ensure-host" });
          // user signed in while a SYSTEM host (pre-login fallback) holds the
          // pipe -> hand over so terminals respawn in the user's context
          if (hostSock && hostUser && hostUser.toUpperCase() === "SYSTEM")
            hostSend({ op: "shutdown" });
          continue;
        }
        switch (m.op) {
          case "data": { const c = a.procs.get(m.id); if (c) c.stdout.emit("data", Buffer.from(m.b64, "base64")); break; }
          case "exit":
          case "err":  { const c = a.procs.get(m.id); if (c) { a.procs.delete(m.id); c.emit("exit"); } break; }
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (a && agents.get(a.id) === a) {
        agents.delete(a.id);
        for (const [, c] of a.procs) c.emit("exit");
      }
    });
  });
  srv.on("error", (e) => console.error("agent link:", e.message));
  srv.listen(AGENT_PORT, "127.0.0.1");
}

// spawn inside the active user session when running as a service. Returns a
// fake {stdin.write, stdout.on('data'), on('exit'), kill} that walks the
// existing screen code paths unchanged; a dead dummy when nobody's logged on.
function spawnSessionProc(exe, args, opts, who) {
  const a = IS_SERVICE ? (who || primaryAgent()) : null;
  if (IS_SERVICE && !a) {
    const dead = new EventEmitter();
    dead.stdin = { write() {} };
    dead.stdout = new EventEmitter();
    dead.kill = () => {};
    setImmediate(() => dead.emit("exit"));
    return dead;
  }
  if (!a) return spawn(exe, args, opts);
  const id = `p${++seq}`;
  const child = new EventEmitter();
  child.stdin = { write: (s) => agentSend(a, { op: "stdin", id, data: Buffer.from(String(s)).toString("base64") }) };
  child.stdout = new EventEmitter();
  child.kill = () => agentSend(a, { op: "kill", id });
  a.procs.set(id, child);
  agentSend(a, { op: "spawn", id, exe, args: args || [], cwd: opts && opts.cwd });
  return child;
}
if (IS_SERVICE) agentListen();

// ---------- session broker ----------
// PTYs live in agent/session-host.js — a detached daemon — so terminal
// sessions (and whatever runs inside them) survive server.js restarts.
// JSONL over a named pipe (win) / unix sock (other); pipe name is per-install.
const HOST_JS = path.join(ROOT, "agent", "session-host.js");
const HOST_ADDR = IS_WIN
  ? "\\\\.\\pipe\\sremote-sessions-" +
    crypto.createHash("sha1").update(ROOT.toLowerCase()).digest("hex").slice(0, 10)
  : path.join(DATA_DIR, "host.sock");
let hostSock = null, hostProc = null, hostConn = null, hostFresh = false;
let attachTok = 0, seq = 0, lastSpawn = 0;
const pendingAttach = new Map(); // tok -> ws
const sessions = new Map();      // id -> {id,name,shell,cwd,workspace,createdAt,exited,clients:Set}

const hostQueue = [];   // ops while the host pipe is down (handover window)
function hostSend(o) {
  if (hostSock && hostSock.writable) { hostSock.write(JSON.stringify(o) + "\n"); return; }
  if (o.op !== "in" && hostQueue.length < 50) hostQueue.push(o);
}
function wantHost() {
  // a logged-on user's agent owns the host in-session; without one we spawn
  // it ourselves — dev mode as the user, service mode as SYSTEM (pre-login)
  const a = IS_SERVICE ? primaryAgent() : null;
  if (a) agentSend(a, { op: "ensure-host" });
  else spawnHost();
}
function spawnHost() {
  if (hostProc || Date.now() - lastSpawn < 3000) return;
  lastSpawn = Date.now();
  try {
    const logFd = fs.openSync(path.join(DATA_DIR, "host.log"), "a");
    hostProc = spawn(process.execPath, [HOST_JS],
      { detached: true, stdio: ["ignore", "ignore", logFd], windowsHide: true, cwd: ROOT });
    hostProc.on("exit", () => { hostProc = null; });
    hostProc.unref();
  } catch (e) { console.error("session host spawn failed:", e.message); }
}
function onHostMsg(m) {
  switch (m.op) {
    case "ready":
      hostUser = m.user || null;
      // the host a user agent spawned belongs to someone — never hand over
      // back to ourselves; only a SYSTEM host gets replaced on logon
      break;
    case "sessions":
      applySessions(m.list);
      broadcastSessions();
      if (hostFresh) { hostFresh = false; reattachAll(); }
      break;
    case "out": {
      const s = sessions.get(m.id); if (!s) break;
      s.lastOut = Date.now(); activityDirty = true;
      logAppend(s, m.data);
      const out = JSON.stringify({ type: "out", id: m.id, data: m.data });
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(out);
      break;
    }
    case "exit": {
      const s = sessions.get(m.id); if (!s) break;
      s.exited = true;
      const out = JSON.stringify({ type: "exit", id: m.id, code: m.code });
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(out);
      logWake(s);
      break;
    }
    case "attached": {
      const ws = pendingAttach.get(m.tok);
      pendingAttach.delete(m.tok);
      if (typeof ws === "function") { ws(m); break; }   // agent-API log seed, not a viewer
      if (!ws || ws.readyState !== 1) break;
      const s = sessions.get(m.id);
      if (s) s.exited = !!m.exited;
      ws.send(JSON.stringify({ type: "attached", id: m.id, exited: m.gone ? true : m.exited }));
      if (m.data) ws.send(JSON.stringify({ type: "out", id: m.id, data: m.data }));
      break;
    }
  }
}
function hostConnect() {
  if (hostSock || hostConn) return;
  const c = net.connect(HOST_ADDR);
  hostConn = c;
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      onHostMsg(m);
    }
  });
  c.on("connect", () => {
    hostSock = c; hostFresh = true;
    for (const o of hostQueue.splice(0)) hostSend(o);
  });
  c.on("error", () => {});
  c.on("close", () => {
    hostConn = null;
    if (hostSock === c) { hostSock = null; hostUser = null; }
    setTimeout(hostConnect, 400); // also (re)spawns broker if it's down
    wantHost();
  });
  // first connect attempt fails when broker isn't up yet — spawn then retry
  c.once("error", () => { wantHost(); setTimeout(hostConnect, 400); });
}
function ensureHost() { hostConnect(); }

function applySessions(list) {
  const seen = new Set();
  for (const r of list) {
    seen.add(r.id);
    const s = sessions.get(r.id);
    if (s) Object.assign(s, r);
    else sessions.set(r.id, { ...r, clients: new Set() });
  }
  for (const id of [...sessions.keys()]) if (!seen.has(id)) sessions.delete(id);
}
function reattachAll() {
  for (const ws of wss ? wss.clients : []) {
    if (!ws._attached || ws.readyState !== 1) continue;
    const tok = ++attachTok;
    pendingAttach.set(tok, ws);
    hostSend({ op: "attach", id: ws._attached, tok });
  }
}

// ---------- agent API: plain-text output log per session ----------
// REST consumers (public/cli/sremote.js, agents) read output by absolute char
// offset instead of holding a WS. ANSI is stripped; tail capped like the host scrollback.
const LOG_MAX = 256 * 1024;
const ANSI_SRC = "\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[PX^_][^\\x1b]*\\x1b\\\\|\\x1b[ -/]+[0-~]|\\x1b[@-Z\\\\-_]";
const ANSI_RE = new RegExp(ANSI_SRC, "g"), ANSI_ONE = new RegExp(`^(?:${ANSI_SRC})`);
const plainText = (d) => d.replace(ANSI_RE, "").replace(/\r+\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
function logAppend(s, data) {
  let d = (s.logPend || "") + data;
  s.logPend = "";
  // an escape sequence split across PTY chunks would leak "[31m" — hold it back
  const k = d.lastIndexOf("\x1b");
  if (k >= 0 && d.length - k < 256 && !ANSI_ONE.test(d.slice(k))) { s.logPend = d.slice(k); d = d.slice(0, k); }
  const t = plainText(d);
  if (!t) return;
  const L = s.log || (s.log = { text: "", base: 0 });
  L.text += t;
  if (L.text.length > LOG_MAX) { const cut = L.text.length - LOG_MAX; L.text = L.text.slice(cut); L.base += cut; }
  logWake(s);
}
function logWake(s) {
  if (!s.waiters) return;
  for (const w of s.waiters) w();
  s.waiters.clear();
}
const logEnd = (s) => (s.log ? s.log.base + s.log.text.length : 0);
// sessions that predate this server process have no log yet — seed it once from
// the broker's scrollback (outs that arrived before the reply are inside it).
// Exited sessions are skipped: a broker attach would respawn them.
function withLog(s, cb) {
  if (s.logSeeded || s.exited || !hostSock) { s.logSeeded = true; return cb(); }
  const tok = ++attachTok;
  const done = (m) => {
    if (s.logSeeded) return;
    s.logSeeded = true;
    if (m && m.data) { s.log = null; s.logPend = ""; logAppend(s, m.data); }
    cb();
  };
  pendingAttach.set(tok, done);
  hostSend({ op: "attach", id: s.id, tok });
  setTimeout(() => { pendingAttach.delete(tok); done(null); }, 3000);
}

// GET /remote.md — instructions an agent on another machine reads before driving
// this host: give it the IP, it fetches this and knows the rest. Generated per
// request so host name, address, shells and projects are always current.
function remoteGuide(req) {
  const hostHdr = /^[\w.:\-\[\]]+$/.test(req.headers.host || "") ? req.headers.host : `${tailscaleIPv4() || "127.0.0.1"}:${PORT}`;
  const base = `http://${hostHdr}`, addr = hostHdr.replace(/:\d+$/, "");
  const shells = Object.keys(SHELLS), def = shells.includes("powershell") ? "powershell" : shells[0];
  const win = IS_WIN;
  const projects = state.workspaces.map((w) => `| ${w.name} | \`${w.path}\` | \`${w.id}\` |`).join("\n");
  const live = sessionList().filter((s) => !s.exited).map((s) => `\`${s.name}\``).join(", ");
  const ex = win ? "C:\\path\\to\\project" : "/path/to/project";
  return `# Remote terminal on ${os.hostname()} (S-remote)

You have been given access to **${os.hostname()}** (${win ? "Windows" : os.platform()}, address \`${addr}\`).
Its terminal is driven over HTTP through S-remote at \`${base}\`. Every session you open shows up
live in the owner's S-remote web UI, so they can watch or take over at any time.

## 1. Setup (once)

Needs Node 18+ on *your* machine. Download the CLI and point it at this host:

\`\`\`bash
curl -o ~/sremote.js ${base}/cli/sremote.js
export SREMOTE_HOST=${hostHdr}            # PowerShell: $env:SREMOTE_HOST='${hostHdr}'
node ~/sremote.js ls                       # connectivity check + list sessions
\`\`\`

If the host is unreachable: both machines must be on the same Tailscale network (\`tailscale status\`).

## 2. Workflow

1. **Open your own session per task** (default shell: \`${def}\`; available: ${shells.map((s) => `\`${s}\``).join(", ")}):
   \`id=$(node ~/sremote.js new --cwd '${ex}' --name <task-name>)\`
   — or \`--workspace <id>\` to open in a project below.
2. **Commands that finish → \`run\`** (waits, prints output, exits with the command's exit code):
   \`node ~/sremote.js run $id -- git status\`
   Put \`--\` before commands that have their own \`--flags\`. Default timeout 600 s (\`--timeout N\`);
   on timeout (exit 124) the command keeps running — read it later with \`read\`.
3. **Long-running processes (dev servers, watchers) → \`send\` + \`wait\`:**
   \`node ~/sremote.js send $id npm run dev\` then
   \`node ~/sremote.js wait $id --for "ready|listening" --timeout 120\`
4. **Interrupt / inspect:** \`node ~/sremote.js key $id ctrl-c\` · \`node ~/sremote.js tail $id\` ·
   \`node ~/sremote.js read $id --since <offset>\`
5. **Clean up:** \`node ~/sremote.js kill $id\` when the task is done (leave it if the user wants to see it).

Full command list: \`node ~/sremote.js --help\`. \`<s>\` may be the session id, its exact name or an id prefix.

## 3. Rules

${win ? `- This is **Windows**: PowerShell syntax and \`C:\\...\` paths. From bash, single-quote commands so \`$\` survives.
` : ""}- Pagers are disabled in sessions created with \`new\` (GIT_PAGER/PAGER=cat). Do not start full-screen
  interactive programs (vim, less, TUIs) via \`run\` — they never finish; use \`send\`/\`key\` if you must.
- Only touch sessions **you** created unless the user asks otherwise.${live ? ` Currently open: ${live}.` : ""}
- Output is plain text (colors stripped), last 256 KB per session.
- You act with the full rights of the logged-in user on this machine — no destructive commands
  (deleting data, uninstalling, rebooting, pushing) without the user's explicit request.

## 4. Projects on this host

${projects ? `| name | path | workspace id |\n|---|---|---|\n${projects}` : "_(none registered — use \`--cwd\`)_"}

## 5. Raw HTTP (if you can't run Node)

\`\`\`
GET    ${base}/api/sessions                       list
POST   ${base}/api/sessions                       {"shell":"${def}","cwd":"...","name":"..."} → {"id"}
POST   ${base}/api/sessions/<id>/input            {"line":"command"} (adds Enter) | {"data":"raw keys"} → {"offset"}
GET    ${base}/api/sessions/<id>/output?since=<offset>&wait=20000
                                                  → {"data","next","exited"}; poll with since=next
DELETE ${base}/api/sessions/<id>                  kill
\`\`\`
`;
}

function createSession({ shell, cwd, cols = 120, rows = 32, workspace, name }) {
  // clients may remember a shell from another host (powershell on a linux box)
  if (!SHELLS[shell]) shell = SHELLS.powershell ? "powershell" : SHELLS.bash ? "bash" : Object.keys(SHELLS)[0];
  // service mode: no host and no user session to bring one up — the caller
  // should show this; pre-login a SYSTEM host may exist and is usable
  if (IS_SERVICE && !hostSock && !primaryAgent()) return null;
  const id = `s${Date.now().toString(36)}-${++seq}`;
  const wsp = workspace ? workspaceById(workspace) : null;
  const dir = wsp ? wsp.path : cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  if (wsp) { wsp.lastUsed = Date.now(); saveState(); }
  const sess = {
    id, name: String(name || "").trim().slice(0, 60) || (wsp ? wsp.name : `${shell} ${seq}`),
    shell, cwd: dir, workspace: wsp ? wsp.id : null,
    createdAt: Date.now(), exited: false, clients: new Set(), logSeeded: true,
  };
  sessions.set(id, sess);
  hostSend({ op: "create", id, name: sess.name, shell, cwd: dir, workspace: sess.workspace, cols, rows });
  broadcastSessions();
  return sess;
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  hostSend({ op: "kill", id });
  sessions.delete(id);
  broadcastSessions();
  return true;
}

function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, shell: s.shell, cwd: s.cwd, workspace: s.workspace,
    createdAt: s.createdAt, exited: s.exited, clients: s.clients.size, lastOut: s.lastOut || 0,
  }));
}
function broadcastSessions() {
  const msg = JSON.stringify({ type: "sessions", list: sessionList() });
  for (const ws of wss ? wss.clients : []) if (ws.readyState === 1) ws.send(msg);
}
// output timestamps for every session (attached or not) → clients show busy/new-output dots;
// coalesced so chatty sessions cost one small frame per tick
let activityDirty = false;
setInterval(() => {
  if (!activityDirty || !wss) return;
  activityDirty = false;
  const map = {};
  for (const s of sessions.values()) if (s.lastOut) map[s.id] = s.lastOut;
  const msg = JSON.stringify({ type: "activity", map });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}, 2500);
// opening a session counts as using its workspace (drives "recent" ordering)
let usedSaveT = null;
function touchWorkspace(id) {
  const w = id && workspaceById(id);
  if (!w) return;
  w.lastUsed = Date.now();
  clearTimeout(usedSaveT);
  usedSaveT = setTimeout(saveState, 2000);
}

// ---------- external integrations (tailscale / netstat / git) ----------
// execFile everywhere — arg arrays only, never shell strings; bounded by timeout
const run = (cmd, args, ms, max = 4 * 1024 * 1024) => new Promise((r) =>
  execFile(cmd, args, { timeout: ms, maxBuffer: max, windowsHide: true },
    (e, so, se) => r({ ok: !e, out: (so || "").toString(), err: (se || (e && e.message) || "").toString() })));

// keep <root>/temp-upload out of the repo index — append to .git/info/exclude
function gitExcludeTmpUpload(root) {
  try {
    if (!fs.existsSync(path.join(root, ".git")) || !fs.statSync(path.join(root, ".git")).isDirectory()) return;
    const info = path.join(root, ".git", "info");
    fs.mkdirSync(info, { recursive: true });
    const ex = path.join(info, "exclude");
    let cur = ""; try { cur = fs.readFileSync(ex, "utf8"); } catch {}
    if (!cur.split(/\r?\n/).includes("temp-upload/"))
      fs.appendFileSync(ex, (cur && !cur.endsWith("\n") ? "\n" : "") + "temp-upload/\n");
  } catch {}
}

// delete stale drop-zone files (mtime > 7 days), best-effort
function sweepTmpUpload(dir) {
  try {
    const now = Date.now();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const f = path.join(dir, e.name);
      try { if (now - fs.statSync(f).mtimeMs > 7 * 86400e3) fs.rmSync(f, { force: true }); } catch {}
    }
  } catch {}
}

async function apiPeers(res) {
  const r = await run("tailscale", ["status", "--json"], 4000);
  let st = null;
  try { st = r.ok ? JSON.parse(r.out) : null; } catch {}
  const nodes = st ? [st.Self, ...Object.values(st.Peer || {})].filter(Boolean) : [];
  const peers = nodes.map((n) => ({
    self: n === (st && st.Self),
    hostname: n.HostName || "", dnsName: (n.DNSName || "").replace(/\.$/, ""), os: n.OS || "",
    ip: (n.TailscaleIPs || []).find((a) => !a.includes(":")) || null,
    online: !!n.Online, direct: !!n.CurAddr, relay: n.Relay || null, userId: n.UserID || null,
    sremote: null,
  }));
  await Promise.allSettled(peers.filter((p) => p.online && p.ip).map(async (p) => {
    try {
      const rr = await fetch(`http://${p.ip}:${PORT}/api/info`, { signal: AbortSignal.timeout(1500) });
      if (rr.ok) p.sremote = await rr.json();
    } catch {}
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ peers }));
}

async function apiDevports(res) {
  const r = IS_WIN
    ? await run("netstat", ["-ano", "-p", "tcp"], 4000)
    : await run("ss", ["-tlnH"], 4000).then((x) => (x.ok ? x : run("netstat", ["-tln"], 4000)));
  const ports = [], seen = new Set(), pids = new Set();
  const localAddr = (s) => { const i = s.lastIndexOf(":"); return i < 0 ? null : [s.slice(0, i), +s.slice(i + 1)]; };
  for (const ln of r.out.split(/\r?\n/)) {
    const t = ln.trim().split(/\s+/);
    let addr = null, port = 0, pid = 0;
    if (IS_WIN) {                       // TCP  local  foreign  LISTENING  pid
      if (t.length < 5 || !/^TCP/i.test(t[0]) || t[3] !== "LISTENING") continue;
      const l = localAddr(t[1]); if (!l) continue;
      [addr, port] = l; pid = +t[4] || 0;
    } else {                            // ss: LISTEN rq sq local peer ; netstat -tln: tcp r s local peer LISTEN
      if (t.length >= 4 && /^LISTEN$/i.test(t[0])) { const l = localAddr(t[3]); if (!l) continue; [addr, port] = l; }
      else if (t.length >= 5 && /^tcp/i.test(t[0]) && /LISTEN/i.test(t[t.length - 1])) {
        const l = localAddr(t[3]); if (!l) continue; [addr, port] = l;
      } else continue;
    }
    if (!port || port === PORT) continue;
    const key = `${addr}:${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (pid) pids.add(pid);
    ports.push({
      port, addr, pid,
      loopback: addr.startsWith("127.") || addr === "::1" || addr === "[::1]",
      proc: null,
    });
  }
  if (IS_WIN && pids.size) {
    const tr = await run("tasklist", ["/fo", "csv", "/nh"], 4000);
    if (tr.ok) {
      const names = {};
      for (const ln of tr.out.split(/\r?\n/)) {
        const m = /^"([^"]*)","(\d+)"/.exec(ln);
        if (m && pids.has(+m[2])) names[m[2]] = m[1];
      }
      for (const p of ports) p.proc = names[p.pid] || null;
    }
  }
  ports.sort((a, b) => a.port - b.port);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ports: ports.slice(0, 50) }));
}

async function apiGit(res, root) {
  const r = await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], 3000);
  if (!r.ok || r.out.trim() !== "true") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ isRepo: false }));
  }
  const br = await run("git", ["-C", root, "branch", "--show-current"], 3000);
  let branch = br.out.trim();
  if (!branch) {
    const h = await run("git", ["-C", root, "rev-parse", "--short", "HEAD"], 3000);
    branch = h.ok ? h.out.trim() : null; // detached; null when HEAD is unborn
  }
  const st = await run("git", ["-C", root, "status", "--porcelain"], 3000);
  const changed = st.ok ? st.out.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ isRepo: true, branch, changed }));
}

async function apiGitDiff(res, root) {
  const chk = await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], 3000);
  if (!chk.ok || chk.out.trim() !== "true") return jsonErr(res, 400, "not a repo");
  const head = await run("git", ["-C", root, "rev-parse", "--verify", "HEAD"], 3000);
  let stat, diff;
  if (head.ok) {
    const [s, d] = await Promise.all([
      run("git", ["-C", root, "diff", "HEAD", "--stat"], 4000),
      run("git", ["-C", root, "diff", "HEAD"], 5000, 32 * 1024 * 1024),
    ]);
    stat = s.out; diff = d.out;
  } else { // unborn HEAD — nothing to diff against; show untracked + unstaged
    const [por, s, d] = await Promise.all([
      run("git", ["-C", root, "status", "--porcelain"], 4000),
      run("git", ["-C", root, "diff", "--stat"], 4000),
      run("git", ["-C", root, "diff"], 5000, 32 * 1024 * 1024),
    ]);
    stat = (por.out + s.out).trim(); diff = d.out;
  }
  const CAP = 256 * 1024;
  const truncated = diff.length > CAP;
  if (truncated) diff = diff.slice(0, CAP);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ stat, diff, truncated }));
}

// ---------- archive helpers (file explorer) ----------
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
// unique-ify a would-be created path: foo.ext -> foo (1).ext / foo -> foo (1)
function freshPath(want) {
  if (!fs.existsSync(want)) return want;
  const dir = path.dirname(want), ext = path.extname(want);
  const stem = ext ? path.basename(want, ext) : path.basename(want);
  for (let i = 1; i < 200; i++) {
    const t = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(t)) return t;
  }
  return want + ".new";
}
// strip archive extension: foo.tar.gz -> foo, foo.zip -> foo
function archiveStem(p) {
  return path.basename(p).replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2|txz|[a-z0-9]{1,5})$/i, "");
}
// extract archive into destDir. bsdtar (ships with Win10+/most linux) reads
// zip/tar/gz/bz2/xz/7z; PowerShell Expand-Archive is the .zip fallback.
function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    const r = execFileSync("tar", ["-xf", archive, "-C", destDir],
      { timeout: 600000, stdio: ["ignore", "pipe", "pipe"] });
    void r; return;
  } catch (e) { if (!/\.zip$/i.test(archive)) throw new Error("extract failed (tar): " + (e.stderr || e.message)); }
  if (!IS_WIN) {   // GNU tar can't read .zip
    try {
      execFileSync("unzip", ["-o", "-q", archive, "-d", destDir], { timeout: 600000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { throw new Error("extract failed (unzip): " + (e.code === "ENOENT" ? "install unzip" : (e.stderr || e.message))); }
    return;
  }
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath ${psq(archive)} -DestinationPath ${psq(destDir)} -Force`],
    { timeout: 600000, stdio: ["ignore", "pipe", "pipe"] });
}
// compress one or more paths into an archive next to destDir/name
function zipInto(paths, destZip, baseDir) {
  if (IS_WIN) {
    const list = paths.map(psq).join(",");
    execFileSync("powershell", ["-NoProfile", "-Command",
      `Compress-Archive -LiteralPath ${list} -DestinationPath ${psq(destZip)} -Force`],
      { timeout: 900000, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    // GNU tar can't emit .zip — fall back to .tar.gz (destZip renamed by caller)
    const tgz = destZip.replace(/\.zip$/i, "") + ".tar.gz";
    execFileSync("tar", ["-czf", tgz, "-C", baseDir, ...paths.map((p) => path.basename(p))],
      { timeout: 900000, stdio: ["ignore", "pipe", "pipe"] });
    return tgz;
  }
  return destZip;
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
// user files (/api/file, /raw/) — broader map so html/media/pdf render inline
const FILE_MIME = {
  ...MIME, ".htm": "text/html", ".mjs": "text/javascript", ".map": "application/json", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon", ".bmp": "image/bmp", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm", ".mkv": "video/webm",
  ".ogv": "video/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
};
const fileMime = (p) => FILE_MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
// stream a file with HTTP Range support — video seeking needs 206 (iOS refuses to play without it)
function sendFile(req, res, target, st, extra = {}) {
  const hdrs = { "Content-Type": fileMime(target), "Accept-Ranges": "bytes", "X-File-Size": st.size, ...extra };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
    let end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end();
    }
    res.writeHead(206, { ...hdrs, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(target, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...hdrs, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(target).pipe(res);
}

function readBody(req, res, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => { let b = {}; try { b = JSON.parse(body); } catch {} cb(b); });
}
function jsonErr(res, code, msg) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!isAllowedRemote(req.socket.remoteAddress)) {
    res.writeHead(403); return res.end("tailnet/localhost only");
  }

  if (url.pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const pa = IS_SERVICE ? primaryAgent() : null;
    return res.end(JSON.stringify({
      hostname: os.hostname(), tailscaleIp: tailscaleIPv4(), home: os.homedir(), root: ROOT,
      platform: os.platform(), shells: Object.keys(SHELLS),
      service: IS_SERVICE, hostUser,
      agent: pa ? { user: pa.user, sess: pa.sess } : null,
      agents: IS_SERVICE ? [...agents.values()].map((x) => ({
        user: x.user, sess: x.sess, sessId: x.sessId, console: x.console,
      })) : undefined,
    }));
  }
  if (url.pathname.toLowerCase() === "/remote.md") {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(remoteGuide(req));
  }
  if (url.pathname === "/api/browse" && req.method === "GET") {
    try {
      const r = browseDir(url.searchParams.get("path") || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.code || "unreadable" }));
    }
  }
  if (url.pathname === "/api/mkdir" && req.method === "POST") {
    return readBody(req, res, (b) => {
      const parent = b.parent || "", name = String(b.name || "").trim();
      if (!name || /[\\/:*?"<>|]/.test(name)) return jsonErr(res, 400, "bad name");
      const target = path.join(parent || "", name);
      if (!parent || !fs.existsSync(parent)) return jsonErr(res, 400, "bad parent");
      try { fs.mkdirSync(target); res.writeHead(200); res.end("{}"); }
      catch (e) { jsonErr(res, 400, e.code || "mkdir failed"); }
    });
  }
  if (url.pathname === "/api/workspaces" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state.workspaces));
  }
  if (url.pathname === "/api/workspaces" && req.method === "POST") {
    return readBody(req, res, (b) => {
      const p = String(b.path || "").trim();
      if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return jsonErr(res, 400, "not a directory");
      const name = String(b.name || "").trim() || path.basename(p.replace(/[\\/]+$/, "")) || p;
      const ws = { id: `w${Date.now().toString(36)}-${++wsSeq}`, name, path: path.resolve(p) };
      state.workspaces.push(ws); saveState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ws));
    });
  }
  const wm = /^\/api\/workspaces\/([\w-]+)$/.exec(url.pathname);
  if (wm && req.method === "PATCH") {
    return readBody(req, res, (b) => {
      const w = workspaceById(wm[1]);
      if (!w) { res.writeHead(404); return res.end(); }
      const name = String(b.name || "").trim().slice(0, 60);
      if (!name) return jsonErr(res, 400, "bad name");
      w.name = name; saveState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(w));
    });
  }
  if (wm && req.method === "DELETE") {
    const i = state.workspaces.findIndex((w) => w.id === wm[1]);
    if (i < 0) { res.writeHead(404); return res.end(); }
    state.workspaces.splice(i, 1); saveState();
    res.writeHead(200); return res.end();
  }
  // file listing/download jailed under a base (workspace id or abs path);
  // base "@abs" = unrestricted absolute paths for the home file explorer —
  // anyone who can reach this UI already has full shell access, so this
  // widens nothing security-wise but unlocks the whole filesystem view.
  const ABS = "@abs";
  const resolveBase = (b) => {
    if (!b) return null;
    if (b === ABS) return ABS;
    if (b.startsWith("ws:")) { const w = workspaceById(b.slice(3)); return w ? w.path : null; }
    const p = path.resolve(b);
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  };
  const jail = (root, rel) => {
    if (root === ABS) return path.resolve(String(rel || "."));
    const t = path.resolve(root, rel || ".");
    return t === root || t.startsWith(root + path.sep) ? t : null;
  };
  const isFsRoot = (t) => path.parse(t).root === t; // C:\ or / — never op on it
  if (url.pathname === "/api/files" && req.method === "GET") {
    const root = resolveBase(url.searchParams.get("base"));
    if (!root) return jsonErr(res, 400, "bad base");
    const target = jail(root, url.searchParams.get("path"));
    if (!target) return jsonErr(res, 403, "outside jail");
    try {
      const items = fs.readdirSync(target, { withFileTypes: true }).slice(0, 2000).map((e) => {
        const full = path.join(target, e.name);
        let st = null; try { st = fs.statSync(full); } catch {}
        return { name: e.name, dir: e.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
      });
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      let rel, parent;
      if (root === ABS) { // absolute-path mode: report real paths so the explorer can navigate
        rel = target;
        const dp = path.dirname(target);
        parent = dp === target ? null : dp;
      } else {
        rel = path.relative(root, target) || "";
        parent = rel === "" ? null : path.dirname(rel) === "." ? "" : path.dirname(rel);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ root: root === ABS ? "" : root, path: rel, parent, items, abs: root === ABS }));
    } catch (e) { return jsonErr(res, 403, e.code || "unreadable"); }
  }
  if (url.pathname === "/api/file" && req.method === "GET") {
    const root = resolveBase(url.searchParams.get("base"));
    if (!root) return jsonErr(res, 400, "bad base");
    const target = jail(root, url.searchParams.get("path"));
    if (!target) return jsonErr(res, 403, "outside jail");
    try {
      const st = fs.statSync(target);
      if (!st.isFile()) return jsonErr(res, 400, "not a file");
      if (url.searchParams.get("head") === "1") { // first 512 KB for text previews
        res.writeHead(200, { "Content-Type": fileMime(target), "Content-Length": Math.min(st.size, 512 * 1024), "X-File-Size": st.size });
        return fs.createReadStream(target, { end: 512 * 1024 - 1 }).pipe(res);
      }
      if (url.searchParams.get("dl") === "1") {
        const fn = path.basename(target).replace(/"/g, "'");
        return sendFile(req, res, target, st, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`,
        });
      }
      return sendFile(req, res, target, st);
    } catch (e) { return jsonErr(res, 403, e.code || "unreadable"); }
  }
  // path-style file access so an html preview resolves its relative css/js/img:
  //   /raw/<base>/<path>  e.g. /raw/@abs/C:/site/index.html, /raw/ws:<id>/docs/a.html
  if (url.pathname.startsWith("/raw/") && (req.method === "GET" || req.method === "HEAD")) {
    let parts;
    try { parts = url.pathname.slice(5).split("/").map(decodeURIComponent); } catch { return jsonErr(res, 400, "bad path"); }
    const root = resolveBase(parts.shift());
    if (!root) return jsonErr(res, 400, "bad base");
    let target = jail(root, root === ABS ? parts.join("/") || "." : parts.join("/"));
    if (!target) return jsonErr(res, 403, "outside jail");
    try {
      let st = fs.statSync(target);
      if (st.isDirectory()) { target = path.join(target, "index.html"); st = fs.statSync(target); }
      if (!st.isFile()) return jsonErr(res, 400, "not a file");
      return sendFile(req, res, target, st, { "Cache-Control": "no-cache" });
    } catch (e) { return jsonErr(res, 404, e.code || "not found"); }
  }
  if (url.pathname === "/api/dbg" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      wsClients: wss ? wss.clients.size : 0,
      screenSubs: scrSubs().length,
      screenAgent: !!scrAgent, shotBusy: scrShotBusy,
      screenProSubs: scrProSubs().length, screenProAgent: !!scrProAgent, screenProInstalled: scrProOk(),
      hostSock: !!hostSock, hostUser, service: IS_SERVICE, agents: agents.size,
      sessions: sessions.size,
    }));
  }
  if (url.pathname === "/api/peers" && req.method === "GET") return apiPeers(res);
  if (url.pathname === "/api/devports" && req.method === "GET") return apiDevports(res);
  if (url.pathname === "/api/git" && req.method === "GET") {
    const root = resolveBase(url.searchParams.get("base"));
    if (!root) return jsonErr(res, 400, "bad base");
    return apiGit(res, root);
  }
  if (url.pathname === "/api/gitdiff" && req.method === "GET") {
    const root = resolveBase(url.searchParams.get("base"));
    if (!root) return jsonErr(res, 400, "bad base");
    return apiGitDiff(res, root);
  }
  // upload into <base>/<dir>/ (default temp-upload) — raw body, name via query
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const root = resolveBase(url.searchParams.get("base"));
    if (!root) return jsonErr(res, 400, "bad base");
    let name = path.basename(url.searchParams.get("name") || "file").replace(/[\\/:*?"<>|]/g, "_") || "file";
    const dir = jail(root, url.searchParams.get("dir") || "temp-upload");
    if (!dir) return jsonErr(res, 403, "outside jail");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return jsonErr(res, 400, e.code || "mkdir failed"); }
    let dest = path.join(dir, name);
    for (let i = 1; fs.existsSync(dest) && i < 100; i++)
      dest = path.join(dir, name.replace(/(\.[^.]+)?$/, ` (${i})$1`));
    const out = fs.createWriteStream(dest);
    let size = 0;
    const fail = (code, msg) => { try { out.destroy(); fs.rmSync(dest, { force: true }); } catch {}; jsonErr(res, code, msg); };
    req.on("data", (c) => { if ((size += c.length) > 4 * 1024 * 1024 * 1024) req.destroy(); });
    req.on("error", () => fail(413, "too large"));
    req.pipe(out);
    out.on("error", (e) => fail(400, e.code || "write failed"));
    out.on("finish", () => {
      if (dir === path.join(root, "temp-upload")) { // default drop zone only
        gitExcludeTmpUpload(root);
        sweepTmpUpload(dir);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dest, rel: path.relative(root, dest), size }));
    });
    return;
  }
  // file ops jailed under a base: {base, op: "rename"|"delete"|"mkdir", path, name}
  if (url.pathname === "/api/fileop" && req.method === "POST") {
    return readBody(req, res, (b) => {
      const root = resolveBase(b.base);
      if (!root) return jsonErr(res, 400, "bad base");
      const target = jail(root, b.path);
      if (!target) return jsonErr(res, 403, "outside jail");
      const okName = (n) => typeof n === "string" && /^[^\\/:*?"<>|]+$/.test(n.trim());
      const jailedChild = (parent, n) => {
        const t = path.join(parent, n.trim());
        return root === ABS || t === root || t.startsWith(root + path.sep) ? t : null;
      };
      if (root === ABS && isFsRoot(target) && b.op !== "mkdir")
        return jsonErr(res, 400, "cannot operate on filesystem root");
      try {
        if (b.op === "rename") {
          if (target === root) return jsonErr(res, 400, "cannot rename base root");
          if (!okName(b.name)) return jsonErr(res, 400, "bad name");
          const dest = jailedChild(path.dirname(target), b.name);
          if (!dest) return jsonErr(res, 403, "outside jail");
          fs.renameSync(target, dest);
        } else if (b.op === "delete") {
          if (target === root) return jsonErr(res, 400, "cannot delete base root");
          fs.rmSync(target, { recursive: true, force: true });
        } else if (b.op === "mkdir") { // path = parent dir, name = new dir
          if (!okName(b.name)) return jsonErr(res, 400, "bad name");
          const dest = jailedChild(target, b.name);
          if (!dest) return jsonErr(res, 403, "outside jail");
          fs.mkdirSync(dest);
        } else if (b.op === "copy" || b.op === "move") {
          // dest = destination DIRECTORY (rel under base, or abs for @abs)
          const destDir = jail(root, b.dest);
          if (!destDir || !fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory())
            return jsonErr(res, 400, "bad dest dir");
          const dest = freshPath(path.join(destDir, path.basename(target)));
          if (b.op === "copy") fs.cpSync(target, dest, { recursive: true });
          else try { fs.renameSync(target, dest); }
          catch (e) { // cross-drive move: copy then remove
            if (e.code !== "EXDEV") throw e;
            fs.cpSync(target, dest, { recursive: true });
            fs.rmSync(target, { recursive: true, force: true });
          }
        } else if (b.op === "extract") {
          const destDir = freshPath(path.join(path.dirname(target), archiveStem(target)));
          extractArchive(target, destDir);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ dir: destDir }));
        } else if (b.op === "zip") {
          // one path -> <name>.zip next to it; several -> files-<ts>.zip in b.dest dir
          const many = Array.isArray(b.paths) && b.paths.length > 1;
          if (many) {
            const destDir = jail(root, b.dest);
            if (!destDir || !fs.statSync(destDir).isDirectory()) return jsonErr(res, 400, "bad dest dir");
            const srcs = [];
            for (const p of b.paths) {
              const t = jail(root, p);
              if (!t || isFsRoot(t)) return jsonErr(res, 403, "outside jail");
              srcs.push(t);
            }
            const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
            const dest = freshPath(path.join(destDir, `files-${ts}.zip`));
            const made = zipInto(srcs, dest, destDir);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ zip: made }));
          }
          const dest = freshPath(path.join(path.dirname(target), path.basename(target) + ".zip"));
          const made = zipInto([target], dest, path.dirname(target));
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ zip: made }));
        } else return jsonErr(res, 400, "bad op");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } catch (e) { jsonErr(res, 400, e.code || "fileop failed"); }
    });
  }
  if (url.pathname === "/api/screen-pro") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ installed: scrProOk(), source: fs.existsSync(SCRPRO_CS) }));
    }
    if (req.method === "POST") {
      const p = scrProOk() ? Promise.resolve({ ok: true, cached: true }) : installScreenPro();
      p.then((r) => { res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); });
      return;
    }
  }
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(sessionList()));
  }
  if (url.pathname === "/api/sessions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let opts = {}; try { opts = JSON.parse(body); } catch {}
      const s = createSession(opts);
      if (!s) return jsonErr(res, 503, "no session host yet — sign in on the host machine to start terminals");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: s.id }));
    });
    return;
  }
  const m = /^\/api\/sessions\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === "DELETE") {
    res.writeHead(killSession(m[1]) ? 200 : 404); return res.end();
  }
  // agent API: type into a session / read its plain-text output by offset
  const am = /^\/api\/sessions\/([\w-]+)\/(input|output)$/.exec(url.pathname);
  if (am) {
    const s = sessions.get(am[1]);
    if (!s) return jsonErr(res, 404, "no such session");
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (am[2] === "input" && req.method === "POST") {
      return readBody(req, res, (b) => withLog(s, () => {
        // {data} = raw keystrokes; {line} = text + Enter
        const data = typeof b.line === "string" ? b.line + "\r" : typeof b.data === "string" ? b.data : "";
        if (!data) return jsonErr(res, 400, "need data or line");
        if (s.exited) return jsonErr(res, 409, "session exited");
        const offset = logEnd(s);           // output caused by this input starts here
        hostSend({ op: "in", id: s.id, data });
        json({ offset });
      }));
    }
    if (am[2] === "output" && req.method === "GET") {
      return withLog(s, () => {
        const q = url.searchParams;
        const wait = Math.min(60000, Math.max(0, +q.get("wait") || 0));
        const reply = () => {
          const L = s.log || { text: "", base: 0 }, end = L.base + L.text.length;
          let since = q.has("since") ? +q.get("since") || 0 : L.base;
          if (q.has("tail")) since = Math.max(since, end - (+q.get("tail") || 0));
          const from = Math.max(L.base, Math.min(since, end));
          json({ data: L.text.slice(from - L.base), since: from, next: end, base: L.base,
            truncated: since < L.base, exited: !!s.exited });
        };
        const since = q.has("since") ? +q.get("since") || 0 : -1;
        if (!wait || s.exited || since < 0 || since < logEnd(s)) return reply();
        // long-poll: hold until new output, exit or timeout
        const waiters = s.waiters || (s.waiters = new Set());
        let t = null;
        const fire = () => { clearTimeout(t); waiters.delete(fire); if (!res.writableEnded) reply(); };
        t = setTimeout(fire, wait);
        waiters.add(fire);
        res.on("close", () => { clearTimeout(t); waiters.delete(fire); });   // req "close" fires early on GET
      });
    }
    return jsonErr(res, 405, "method not allowed");
  }

  // static — no-cache + etag so mobile browsers never hold stale UI
  let fp = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const abs = path.join(PUBLIC, fp);
  if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  const st = fs.statSync(abs);
  const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;
  const headers = { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: etag };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  fs.createReadStream(abs).pipe(res);
});

// ---------- screen share (windows: powershell gdi+ agent, JSONL stdio) ----------
const SCR_PS1 = path.join(ROOT, "agent", "screen-agent.ps1");
let scrAgent = null, scrShotBusy = false, scrKillT = null;
const scrSubs = () => [...(wss ? wss.clients : [])].filter((c) => c._screen && c.readyState === 1);
function scrStopSoon() {
  clearTimeout(scrKillT);
  scrKillT = setTimeout(() => {
    if (!scrSubs().length && scrAgent) { try { scrAgent.kill(); } catch {} }
  }, 30000);
}
function scrEnsure() {
  if (scrAgent) return;
  scrAgent = spawnSessionProc("powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCR_PS1],
    { stdio: ["pipe", "pipe", "ignore"] }, screenRelayAgent());
  let buf = "";
  scrAgent.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.op === "frame" || m.op === "err" || m.op === "info") scrShotBusy = false;
      const out = JSON.stringify({ type: "screen", ...m });
      for (const ws of scrSubs()) ws.send(out);
    }
  });
  scrAgent.on("exit", () => {
    scrAgent = null; scrShotBusy = false;
    for (const ws of scrSubs())
      ws.send(JSON.stringify({ type: "screen", op: "err", msg: "capture agent exited" }));
  });
}
function scrCmd(o) {
  scrEnsure();
  if (o.op === "shot") { if (scrShotBusy) return; scrShotBusy = true; }
  try { scrAgent.stdin.write(JSON.stringify(o) + "\n"); }
  catch { scrShotBusy = false; }
}

// ---------- screen pro (native dxgi agent, binary tile frames) ----------
const SCRPRO_DIR = path.join(ROOT, "agent", "screen-pro");
const SCRPRO_EXE = path.join(SCRPRO_DIR, "ScreenPro.exe");
const SCRPRO_CS = path.join(SCRPRO_DIR, "ScreenPro.cs");
const SCRPRO_VER = path.join(SCRPRO_DIR, "ScreenPro.ver"); // sha1 of the .cs the exe was built from
let scrProAgent = null, scrProBuf = Buffer.alloc(0), scrProKillT = null;
let scrProCredit = 2;          // frames the agent may still send (mirrors its counter)
let scrProBuilding = null;     // promise while csc runs
const scrProSha = () => { try { return crypto.createHash("sha1").update(fs.readFileSync(SCRPRO_CS)).digest("hex"); } catch { return ""; } };
// installed = exe exists and was built from the current source (updates ship a new .cs)
const scrProOk = () => {
  if (!fs.existsSync(SCRPRO_EXE)) return false;
  try { return fs.readFileSync(SCRPRO_VER, "utf8").trim() === scrProSha(); } catch { return false; }
};
const scrProSubs = () => [...(wss ? wss.clients : [])].filter((c) => c._screenPro && c.readyState === 1);
// credit flow: a viewer that acks frames ("flow") may have at most 2 in flight;
// the slowest one paces the agent, which coalesces changes instead of queueing
function scrProPump() {
  if (!scrProAgent) return;
  const flow = scrProSubs().filter((c) => c._flow);
  const maxIn = flow.length ? Math.max(...flow.map((c) => c._inflight || 0)) : 0;
  const allowed = Math.max(0, 2 - maxIn);
  if (allowed > scrProCredit) {
    try { scrProAgent.stdin.write(JSON.stringify({ op: "credit", n: allowed - scrProCredit }) + "\n"); } catch {}
    scrProCredit = allowed;
  }
}
function scrProStopSoon() {
  clearTimeout(scrProKillT);
  scrProKillT = setTimeout(() => {
    if (!scrProSubs().length && scrProAgent) {
      try { scrProAgent.stdin.write(JSON.stringify({ op: "block", on: false }) + "\n" + JSON.stringify({ op: "quit" }) + "\n"); } catch {}
      setTimeout(() => { try { scrProAgent && scrProAgent.kill(); } catch {} }, 800);
    }
  }, 30000);
}
function scrProEnsure() {
  if (scrProAgent) return;
  scrProAgent = spawnSessionProc(SCRPRO_EXE, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, cwd: SCRPRO_DIR }, screenRelayAgent());
  scrProCredit = 2;
  const me = scrProAgent;
  scrProAgent.stdout.on("data", (d) => {
    scrProBuf = Buffer.concat([scrProBuf, d]);
    while (scrProBuf.length >= 5) {
      const len = scrProBuf.readUInt32LE(0);
      if (scrProBuf.length < 4 + len) break;
      const t = scrProBuf[4], pl = scrProBuf.slice(5, 4 + len);
      scrProBuf = scrProBuf.slice(4 + len);
      if (t === 0x4a) {                              // 'J' -> JSON control msg
        let m; try { m = JSON.parse(pl.toString("utf8")); } catch { continue; }
        const out = JSON.stringify({ type: "screen", pro: true, ...m });
        for (const ws of scrProSubs()) ws.send(out);
      } else {                                       // 'F' -> binary tile frame
        scrProCredit = Math.max(0, scrProCredit - 1);
        const out = Buffer.concat([Buffer.from([t]), pl]);
        for (const ws of scrProSubs()) {
          if (ws._flow) ws._inflight = (ws._inflight || 0) + 1;
          else if (ws.bufferedAmount > 4 << 20) continue;   // legacy viewer on a slow link: drop
          ws.send(out, { binary: true });
        }
        scrProPump();
      }
    }
  });
  scrProAgent.on("exit", () => {
    if (scrProAgent !== me) return;
    scrProAgent = null; scrProBuf = Buffer.alloc(0);
    for (const ws of scrProSubs())
      ws.send(JSON.stringify({ type: "screen", pro: true, op: "err", msg: "pro agent exited" }));
  });
}
function scrProCmd(o) {
  scrProEnsure();
  try { scrProAgent.stdin.write(JSON.stringify(o) + "\n"); } catch {}
}
// compile ScreenPro.cs with the .NET Framework csc (async — csc takes a few seconds).
// A running (old) agent holds the exe open, so it is stopped first.
function installScreenPro() {
  if (scrProBuilding) return scrProBuilding;
  if (!fs.existsSync(SCRPRO_CS)) return Promise.resolve({ ok: false, error: "ScreenPro.cs missing" });
  const windir = process.env.WINDIR || "C:\\Windows";
  const csc = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find(fs.existsSync);
  if (!csc) return Promise.resolve({ ok: false, error: "no .NET csc.exe found" });
  fs.mkdirSync(SCRPRO_DIR, { recursive: true });
  scrProBuilding = new Promise((resolve) => {
    const build = () => {
      const tmp = SCRPRO_EXE + ".new";
      execFile(csc, ["/nologo", "/unsafe", "/optimize+", "/target:exe",
        `/out:${tmp}`, "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
        "/r:System.Web.Extensions.dll", SCRPRO_CS], { timeout: 90000, windowsHide: true }, (err, stdout, stderr) => {
        if (err || !fs.existsSync(tmp)) {
          try { fs.unlinkSync(tmp); } catch {}
          return resolve({ ok: false, error: "compile failed: " + String(stdout || stderr || (err && err.message) || "").slice(0, 500) });
        }
        try {
          fs.renameSync(tmp, SCRPRO_EXE);
          fs.writeFileSync(SCRPRO_VER, scrProSha());
          resolve({ ok: true });
        } catch (e) { resolve({ ok: false, error: "install failed: " + e.message }); }
      });
    };
    if (scrProAgent) {
      const a = scrProAgent;
      a.once("exit", () => setTimeout(build, 200));
      try { a.kill(); } catch { build(); }
    } else build();
  }).finally(() => { scrProBuilding = null; });
  return scrProBuilding;
}
// subscribe a viewer to pro mode, building the agent first when missing/stale
async function scrProSub(ws, msg) {
  if (!scrProOk()) {
    ws.send(JSON.stringify({ type: "screen", pro: true, op: "status", msg: "building screen agent…" }));
    const r = await installScreenPro();
    if (!r.ok) return ws.send(JSON.stringify({ type: "screen", pro: true, op: "pro-needed", error: r.error }));
  }
  if (ws.readyState !== 1) return;
  ws._screenPro = true; ws._flow = !!msg.flow; ws._inflight = 0; clearTimeout(scrProKillT);
  scrProCmd({ op: "config", w: msg.w || 1600, fps: msg.fps || 30, q: msg.q || 70 });
  if (msg.mon !== undefined) scrProCmd({ op: "mon", i: msg.mon });
  scrProCmd({ op: "refresh" });
  scrProPump();
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  if (!isAllowedRemote(req.socket.remoteAddress)) {
    return ws.close(4403, "tailnet/localhost only");
  }
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const s = msg.id ? sessions.get(msg.id) : null;
    switch (msg.type) {
      case "attach": {
        if (!s) return;
        s.clients.add(ws);
        ws._attached = msg.id;
        touchWorkspace(s.workspace);
        const tok = ++attachTok;
        pendingAttach.set(tok, ws);
        // broker revives exited sessions and replies with scrollback
        hostSend({ op: "attach", id: s.id, tok, cols: msg.cols, rows: msg.rows });
        break;
      }
      case "detach":
        if (s) { s.clients.delete(ws); ws._attached = null; }
        break;
      case "in":
        if (s && !s.exited) hostSend({ op: "in", id: s.id, data: msg.data });
        break;
      case "resize":
        if (s && !s.exited) hostSend({ op: "resize", id: s.id, cols: msg.cols, rows: msg.rows });
        break;
      case "create": {
        const ns = createSession({ shell: msg.shell, cwd: msg.cwd, cols: msg.cols, rows: msg.rows, workspace: msg.workspace, name: msg.name });
        ws.send(ns
          ? JSON.stringify({ type: "created", id: ns.id })
          : JSON.stringify({ type: "err", msg: "no session host yet — sign in on the host machine" }));
        break;
      }
      case "rename":
        if (s) {
          const n = String(msg.name || "").trim().slice(0, 60);
          if (n) { s.name = n; hostSend({ op: "rename", id: s.id, name: n }); broadcastSessions(); }
        }
        break;
      case "kill":
        if (s) killSession(s.id);
        break;
      case "list":
        ws.send(JSON.stringify({ type: "sessions", list: sessionList() }));
        break;
      case "screen": {
        if (!IS_WIN) {
          ws.send(JSON.stringify({ type: "screen", op: "err", msg: "screen share is Windows-only" }));
          break;
        }
        if (IS_SERVICE && !screenRelayAgent() && (msg.op === "sub" || msg.op === "shot" || msg.op === "info")) {
          ws.send(JSON.stringify({ type: "screen", op: "err",
            msg: "no user session on the host — sign in there to enable remote screen" }));
          break;
        }
        const { type, ...cmd } = msg;
        if (msg.pro) {
          // pro mode: native dxgi agent, push binary tile frames
          if (msg.op === "sub") { scrProSub(ws, msg); break; }
          if (msg.op === "unsub") { ws._screenPro = false; scrProStopSoon(); scrProPump(); break; }
          if (msg.op === "ack") { ws._inflight = Math.max(0, (ws._inflight || 0) - 1); scrProPump(); break; }
          if (!ws._screenPro || !scrProAgent) break;           // input only from subscribed viewers
          delete cmd.pro;
          if (cmd.op === "config") { cmd.w = cmd.w || 1600; cmd.fps = cmd.fps || 30; cmd.q = cmd.q || 70; }
          scrProCmd(cmd);
        } else if (msg.op === "sub") {
          ws._screen = true; clearTimeout(scrKillT);
          scrCmd({ op: "info" });
          scrCmd({ op: "shot", w: msg.w || 1280, q: 55 });
        } else if (msg.op === "unsub") {
          ws._screen = false; scrStopSoon();
        } else scrCmd(cmd);
        break;
      }
      case "ping":
        ws.send(JSON.stringify({ type: "pong", t: msg.t }));
        break;
    }
  });
  ws.on("close", () => {
    for (const s of sessions.values()) s.clients.delete(ws);
    for (const [tok, w] of pendingAttach) if (w === ws) pendingAttach.delete(tok);
    if (ws._screen) { ws._screen = false; scrStopSoon(); }
    if (ws._screenPro) { ws._screenPro = false; scrProStopSoon(); scrProPump(); }
  });
});

// ---------- boot ----------
ensureHost(); // connect to (or spawn) the session broker — PTYs live there
for (const w of state.workspaces) sweepTmpUpload(path.join(w.path, "temp-upload"));

server.listen(PORT, "0.0.0.0", () => {
  const ip = tailscaleIPv4();
  console.log(`S-remote listening on :${PORT}` + (IS_SERVICE ? ` (service, agent link 127.0.0.1:${AGENT_PORT})` : ""));
  console.log(`  local:     http://localhost:${PORT}`);
  if (ip) console.log(`  tailscale: http://${ip}:${PORT}`);
  console.log(`  restored:  ${sessions.size} session(s) from history`);
});
