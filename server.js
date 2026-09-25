// S-remote — direct remote terminal over Tailscale (no relay)
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

const PORT = 2209;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const STATE_FILE = path.join(ROOT, "state.json");
const SB_DIR = path.join(ROOT, "data", "scrollback");
const SCROLLBACK_MAX = 256 * 1024;
fs.mkdirSync(SB_DIR, { recursive: true });

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

const sbFile = (id) => path.join(SB_DIR, `${id}.bin`);
function loadScrollback(id) {
  try { return fs.readFileSync(sbFile(id)); } catch { return Buffer.alloc(0); }
}
function flushScrollback(s) {
  if (!s.sbDirty) return;
  try { fs.writeFileSync(sbFile(s.id), s.scrollback); } catch {}
  s.sbDirty = false;
}
function persistSessions() {
  state.sessions = [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, shell: s.shell, cwd: s.cwd,
    workspace: s.workspace, createdAt: s.createdAt, exited: s.exited,
  }));
  saveState();
}

// ---------- directory browse ----------
function listDrives() {
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
const SHELLS = {
  powershell: { path: "powershell.exe", args: ["-NoLogo"] },
  cmd: { path: "cmd.exe", args: [] },
  pwsh: { path: "pwsh.exe", args: ["-NoLogo"] },
};

// ---------- PTY sessions (persisted & restorable) ----------
const sessions = new Map(); // id -> {id,name,shell,cwd,workspace,proc,scrollback,createdAt,clients:Set,exited}
let seq = 0;
const RESTORE_MARK = "\r\n\x1b[90m── session restored ──\x1b[0m\r\n";

// env vars injected by IDE/agent hosts — must not leak into spawned shells,
// otherwise tools like `devin` think they run inside an ACP host
const ENV_DENY = /^(ACP_|WINDSURF_|VSCODE_|TERM_PROGRAM|TERM_SESSION_ID|EXEPATH$|PLINK_PROTOCOL$)/i;
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!ENV_DENY.test(k)) env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // our renderer is xterm.js — same engine as VS Code's terminal; claim it so
  // TUIs don't fall back to "conhost" detection on Windows
  env.TERM_PROGRAM = "vscode";
  return env;
}

function spawnProc(sess) {
  const s = SHELLS[sess.shell] || SHELLS.powershell;
  const proc = pty.spawn(s.path, s.args, {
    name: "xterm-256color", cols: sess.cols || 120, rows: sess.rows || 32, cwd: sess.cwd,
    env: cleanEnv(),
  });
  sess.proc = proc;
  sess.exited = false;
  proc.onData((d) => {
    const buf = Buffer.from(d, "utf8");
    sess.scrollback = Buffer.concat([sess.scrollback, buf]).subarray(-SCROLLBACK_MAX);
    sess.sbDirty = true;
    const msg = JSON.stringify({ type: "out", id: sess.id, data: d });
    for (const ws of sess.clients) if (ws.readyState === 1) ws.send(msg);
  });
  proc.onExit(({ exitCode }) => {
    sess.exited = true;
    flushScrollback(sess);
    persistSessions();
    const msg = JSON.stringify({ type: "exit", id: sess.id, code: exitCode });
    for (const ws of sess.clients) if (ws.readyState === 1) ws.send(msg);
    broadcastSessions();
  });
}

function createSession({ shell = "powershell", cwd, cols = 120, rows = 32, workspace, name }) {
  const id = `s${Date.now().toString(36)}-${++seq}`;
  const wsp = workspace ? workspaceById(workspace) : null;
  const dir = wsp ? wsp.path : cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  if (wsp) { wsp.lastUsed = Date.now(); saveState(); }
  const sess = {
    id, name: String(name || "").trim().slice(0, 60) || (wsp ? wsp.name : `${shell} ${seq}`), shell, cwd: dir,
    workspace: wsp ? wsp.id : null, cols, rows,
    proc: null, scrollback: Buffer.alloc(0), createdAt: Date.now(), clients: new Set(),
    exited: false, sbDirty: false,
  };
  sessions.set(id, sess);
  spawnProc(sess);
  persistSessions();
  broadcastSessions();
  return sess;
}

function restoreSessions() {
  for (const rec of state.sessions) {
    if (sessions.has(rec.id)) continue;
    const sess = {
      ...rec, proc: null, scrollback: loadScrollback(rec.id),
      clients: new Set(), sbDirty: false,
    };
    sessions.set(sess.id, sess);
    if (!rec.exited && fs.existsSync(sess.cwd)) {
      sess.scrollback = Buffer.concat([sess.scrollback, Buffer.from(RESTORE_MARK)]).subarray(-SCROLLBACK_MAX);
      try { spawnProc(sess); } catch { sess.exited = true; }
    }
  }
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.proc && s.proc.kill(); } catch {}
  sessions.delete(id);
  try { fs.rmSync(sbFile(id), { force: true }); } catch {}
  persistSessions();
  broadcastSessions();
  return true;
}

function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, shell: s.shell, cwd: s.cwd, workspace: s.workspace,
    createdAt: s.createdAt, exited: s.exited,
    clients: s.clients.size,
  }));
}
function broadcastSessions() {
  const msg = JSON.stringify({ type: "sessions", list: sessionList() });
  for (const ws of wss ? wss.clients : []) if (ws.readyState === 1) ws.send(msg);
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
      hostname: os.hostname(), tailscaleIp: tailscaleIPv4(), home: os.homedir(),
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
  // upload into <base>/temp-upload/ — raw body, name via query
  if (url.pathname === "/api/upload" && req.method === "POST") {
    const root = resolveBase(url.searchParams.get("base"));
    if (!root) return jsonErr(res, 400, "bad base");
    let name = path.basename(url.searchParams.get("name") || "file").replace(/[\\/:*?"<>|]/g, "_") || "file";
    const dir = path.join(root, "temp-upload");
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dest, rel: path.relative(root, dest), size }));
    });
    return;
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
        // revive a dead/exited session: fresh shell at same cwd, scrollback kept
        if (s.exited || !s.proc) {
          if (!fs.existsSync(s.cwd)) break;
          s.scrollback = Buffer.concat([s.scrollback, Buffer.from(RESTORE_MARK)]).subarray(-SCROLLBACK_MAX);
          try { spawnProc(s); } catch { break; }
          persistSessions();
          broadcastSessions();
        }
        s.clients.add(ws);
        ws._attached = msg.id;
        ws.send(JSON.stringify({ type: "attached", id: s.id, exited: s.exited }));
        if (s.scrollback.length) ws.send(JSON.stringify({ type: "out", id: s.id, data: s.scrollback.toString("utf8") }));
        if (msg.cols && s.proc) { try { s.proc.resize(msg.cols, msg.rows); } catch {} }
        break;
      }
      case "detach":
        if (s) { s.clients.delete(ws); ws._attached = null; }
        break;
      case "in":
        if (s && !s.exited && s.proc) s.proc.write(msg.data);
        break;
      case "resize":
        if (s && !s.exited && s.proc) { try { s.proc.resize(msg.cols, msg.rows); } catch {} }
        break;
      case "create": {
        const ns = createSession({ shell: msg.shell, cwd: msg.cwd, cols: msg.cols, rows: msg.rows, workspace: msg.workspace });
        ws.send(JSON.stringify({ type: "created", id: ns.id }));
        break;
      }
      case "rename":
        if (s) {
          const n = String(msg.name || "").trim().slice(0, 60);
          if (n) { s.name = n; persistSessions(); broadcastSessions(); }
        }
        break;
      case "kill":
        if (s) killSession(s.id);
        break;
      case "list":
        ws.send(JSON.stringify({ type: "sessions", list: sessionList() }));
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong", t: msg.t }));
        break;
    }
  });
  ws.on("close", () => {
    for (const s of sessions.values()) s.clients.delete(ws);
  });
});

// ---------- boot ----------
restoreSessions();
setInterval(() => { for (const s of sessions.values()) flushScrollback(s); }, 3000);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    for (const s of sessions.values()) flushScrollback(s);
    process.exit(0);
  });
}

server.listen(PORT, "0.0.0.0", () => {
  const ip = tailscaleIPv4();
  console.log(`S-remote listening on :${PORT}`);
  console.log(`  local:     http://localhost:${PORT}`);
  if (ip) console.log(`  tailscale: http://${ip}:${PORT}`);
  console.log(`  restored:  ${sessions.size} session(s) from history`);
});
