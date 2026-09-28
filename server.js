// S-remote — direct remote terminal over Tailscale (no relay)
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const { spawn, execFile, execFileSync } = require("child_process");
const net = require("net");
const crypto = require("crypto");

const PORT = 2209;
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

function hostSend(o) {
  if (hostSock && hostSock.writable) hostSock.write(JSON.stringify(o) + "\n");
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
    case "sessions":
      applySessions(m.list);
      broadcastSessions();
      if (hostFresh) { hostFresh = false; reattachAll(); }
      break;
    case "out": {
      const s = sessions.get(m.id); if (!s) break;
      const out = JSON.stringify({ type: "out", id: m.id, data: m.data });
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(out);
      break;
    }
    case "exit": {
      const s = sessions.get(m.id); if (!s) break;
      s.exited = true;
      const out = JSON.stringify({ type: "exit", id: m.id, code: m.code });
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(out);
      break;
    }
    case "attached": {
      const ws = pendingAttach.get(m.tok);
      pendingAttach.delete(m.tok);
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
  c.on("connect", () => { hostSock = c; hostFresh = true; });
  c.on("error", () => {});
  c.on("close", () => {
    hostConn = null;
    if (hostSock === c) hostSock = null;
    setTimeout(hostConnect, 400); // also (re)spawns broker if it's down
    spawnHost();
  });
  // first connect attempt fails when broker isn't up yet — spawn then retry
  c.once("error", () => { spawnHost(); setTimeout(hostConnect, 400); });
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

function createSession({ shell = "powershell", cwd, cols = 120, rows = 32, workspace, name }) {
  const id = `s${Date.now().toString(36)}-${++seq}`;
  const wsp = workspace ? workspaceById(workspace) : null;
  const dir = wsp ? wsp.path : cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  if (wsp) { wsp.lastUsed = Date.now(); saveState(); }
  const sess = {
    id, name: String(name || "").trim().slice(0, 60) || (wsp ? wsp.name : `${shell} ${seq}`),
    shell, cwd: dir, workspace: wsp ? wsp.id : null,
    createdAt: Date.now(), exited: false, clients: new Set(),
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
    createdAt: s.createdAt, exited: s.exited, clients: s.clients.size,
  }));
}
function broadcastSessions() {
  const msg = JSON.stringify({ type: "sessions", list: sessionList() });
  for (const ws of wss ? wss.clients : []) if (ws.readyState === 1) ws.send(msg);
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

// ---------- HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

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
    return res.end(JSON.stringify({
      hostname: os.hostname(), tailscaleIp: tailscaleIPv4(), home: os.homedir(), root: ROOT,
      platform: os.platform(), shells: Object.keys(SHELLS),
    }));
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
  // file listing/download jailed under a base (workspace id or abs path)
  const resolveBase = (b) => {
    if (!b) return null;
    if (b.startsWith("ws:")) { const w = workspaceById(b.slice(3)); return w ? w.path : null; }
    const p = path.resolve(b);
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  };
  const jail = (root, rel) => {
    const t = path.resolve(root, rel || ".");
    return t === root || t.startsWith(root + path.sep) ? t : null;
  };
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
      const rel = path.relative(root, target) || "";
      const parent = rel === "" ? null : path.dirname(rel) === "." ? "" : path.dirname(rel);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ root, path: rel, parent, items }));
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
      const headOnly = url.searchParams.get("head") === "1";
      const hdrs = {
        "Content-Type": url.searchParams.get("dl") === "1"
          ? "application/octet-stream"
          : MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Content-Length": headOnly ? Math.min(st.size, 512 * 1024) : st.size,
        "X-File-Size": st.size,
      };
      if (url.searchParams.get("dl") === "1") {
        const fn = path.basename(target).replace(/"/g, "'");
        hdrs["Content-Disposition"] =
          `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`;
      }
      res.writeHead(200, hdrs);
      const stream = fs.createReadStream(target, headOnly ? { end: 512 * 1024 - 1 } : {});
      return stream.pipe(res);
    } catch (e) { return jsonErr(res, 403, e.code || "unreadable"); }
  }
  if (url.pathname === "/api/dbg" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      wsClients: wss ? wss.clients.size : 0,
      screenSubs: scrSubs().length,
      screenAgent: !!scrAgent, shotBusy: scrShotBusy,
      screenProSubs: scrProSubs().length, screenProAgent: !!scrProAgent, screenProInstalled: scrProOk(),
      hostSock: !!hostSock, sessions: sessions.size,
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
    req.on("data", (c) => { if ((size += c.length) > 100 * 1024 * 1024) req.destroy(); });
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
        return t === root || t.startsWith(root + path.sep) ? t : null;
      };
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
      const r = scrProOk() ? { ok: true, cached: true } : installScreenPro();
      res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(r));
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: s.id }));
    });
    return;
  }
  const m = /^\/api\/sessions\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === "DELETE") {
    res.writeHead(killSession(m[1]) ? 200 : 404); return res.end();
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
  scrAgent = spawn("powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCR_PS1],
    { stdio: ["pipe", "pipe", "ignore"] });
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
let scrProAgent = null, scrProBuf = Buffer.alloc(0), scrProKillT = null;
const scrProOk = () => fs.existsSync(SCRPRO_EXE);
const scrProSubs = () => [...(wss ? wss.clients : [])].filter((c) => c._screenPro && c.readyState === 1);
function scrProStopSoon() {
  clearTimeout(scrProKillT);
  scrProKillT = setTimeout(() => {
    if (!scrProSubs().length && scrProAgent) { try { scrProAgent.kill(); } catch {} }
  }, 30000);
}
function scrProEnsure() {
  if (scrProAgent) return;
  scrProAgent = spawn(SCRPRO_EXE, [], { stdio: ["pipe", "pipe", "ignore"] });
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
        const out = Buffer.concat([Buffer.from([t]), pl]);
        for (const ws of scrProSubs()) ws.send(out, { binary: true });
      }
    }
  });
  scrProAgent.on("exit", () => {
    scrProAgent = null; scrProBuf = Buffer.alloc(0);
    for (const ws of scrProSubs())
      ws.send(JSON.stringify({ type: "screen", pro: true, op: "err", msg: "pro agent exited" }));
  });
}
function scrProCmd(o) {
  scrProEnsure();
  try { scrProAgent.stdin.write(JSON.stringify(o) + "\n"); } catch {}
}
function installScreenPro() {
  if (!fs.existsSync(SCRPRO_CS)) return { ok: false, error: "ScreenPro.cs missing" };
  const windir = process.env.WINDIR || "C:\\Windows";
  const csc = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find(fs.existsSync);
  if (!csc) return { ok: false, error: "no .NET csc.exe found" };
  fs.mkdirSync(SCRPRO_DIR, { recursive: true });
  try {
    execFileSync(csc, ["/nologo", "/unsafe", "/target:exe",
      `/out:${SCRPRO_EXE}`, "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
      "/r:System.Web.Extensions.dll", SCRPRO_CS], { timeout: 60000, windowsHide: true });
    return { ok: fs.existsSync(SCRPRO_EXE) };
  } catch (e) {
    const out = (e.stdout || e.stderr || e.message || e).toString().slice(0, 500);
    return { ok: false, error: "compile failed: " + out };
  }
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
        ws.send(JSON.stringify({ type: "created", id: ns.id }));
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
        const { type, ...cmd } = msg;
        if (msg.pro) {
          // pro mode: native dxgi agent, push binary tile frames
          if (!scrProOk()) {
            ws.send(JSON.stringify({ type: "screen", pro: true, op: "pro-needed" }));
          } else if (msg.op === "sub") {
            ws._screenPro = true; clearTimeout(scrProKillT);
            scrProCmd({ op: "config", w: msg.w || 1280, fps: 15, q: 70 });
          } else if (msg.op === "unsub") {
            ws._screenPro = false; scrProStopSoon();
          } else scrProCmd(cmd);
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
    if (ws._screenPro) { ws._screenPro = false; scrProStopSoon(); }
  });
});

// ---------- boot ----------
ensureHost(); // connect to (or spawn) the session broker — PTYs live there
for (const w of state.workspaces) sweepTmpUpload(path.join(w.path, "temp-upload"));

server.listen(PORT, "0.0.0.0", () => {
  const ip = tailscaleIPv4();
  console.log(`S-remote listening on :${PORT}`);
  console.log(`  local:     http://localhost:${PORT}`);
  if (ip) console.log(`  tailscale: http://${ip}:${PORT}`);
  console.log(`  restored:  ${sessions.size} session(s) from history`);
});
