// S-remote session host — owns PTYs + scrollback so terminal sessions
// survive server.js restarts. Talks JSONL over a named pipe (win) or
// unix socket (other). Spawned detached by server.js; safe to run solo.
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const pty = require("node-pty");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SB_DIR = path.join(DATA_DIR, "scrollback");
const SESS_FILE = path.join(DATA_DIR, "sessions.json");
const LEGACY_STATE = path.join(ROOT, "state.json"); // migrate sessions[] out once
const SCROLLBACK_MAX = 256 * 1024;
const IS_WIN = process.platform === "win32";
fs.mkdirSync(SB_DIR, { recursive: true });

const HOST_ADDR = IS_WIN
  ? "\\\\.\\pipe\\sremote-sessions-" +
    crypto.createHash("sha1").update(ROOT.toLowerCase()).digest("hex").slice(0, 10)
  : path.join(DATA_DIR, "host.sock");

const log = (...a) => console.error(`[host ${new Date().toISOString()}]`, ...a);

// ---------- shells ----------
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

// env vars injected by IDE/agent hosts — must not leak into spawned shells,
// otherwise tools like `devin` think they run inside an ACP host
const ENV_DENY = /^(ACP_|WINDSURF_|VSCODE_|TERM_PROGRAM|TERM_SESSION_ID|EXEPATH$|PLINK_PROTOCOL$)/i;
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!ENV_DENY.test(k)) env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "vscode"; // xterm.js renderer — same engine as VS Code
  return env;
}

// ---------- sessions ----------
const sessions = new Map(); // id -> {id,name,shell,cwd,workspace,createdAt,exited,proc,scrollback,sbDirty}
const RESTORE_MARK = "\r\n\x1b[90m── session restored ──\x1b[0m\r\n";
const sbFile = (id) => path.join(SB_DIR, `${id}.bin`);
// DEC private modes a replay must get right. The scrollback is a 256KB tail,
// so the toggles that switched them on (Claude Code: alt screen + mouse
// tracking, sent once at startup) are often cut off — track them live.
const ALT_MODES = ["1049", "1047", "47"];
const MOUSE_MODES = ["1000", "1002", "1003", "1005", "1006", "1015"];
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;
function trackModes(modes, d) {
  for (const m of d.matchAll(MODE_RE))
    for (const p of m[1].split(";")) if (ALT_MODES.includes(p) || MOUSE_MODES.includes(p)) modes[p] = m[2] === "h";
}
function replayData(s) {
  let data = s.scrollback.toString("utf8");
  const cur = s.modes || {}, curAlt = ALT_MODES.some((p) => cur[p]);
  const end = {}; trackModes(end, data);
  const toggled = ALT_MODES.some((p) => p in end), endAlt = ALT_MODES.some((p) => end[p]);
  if (!toggled && curAlt) data = "\x1b[?1049h" + data; // whole tail was drawn on the alt screen
  else if (toggled && endAlt !== curAlt) data += curAlt ? "\x1b[?1049h" : "\x1b[?1049l"; // e.g. respawned
  for (const p of MOUSE_MODES) data += `\x1b[?${p}${cur[p] ? "h" : "l"}`;
  return data;
}

function persist() {
  const list = [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, shell: s.shell, cwd: s.cwd,
    workspace: s.workspace, createdAt: s.createdAt, exited: s.exited,
  }));
  try { fs.writeFileSync(SESS_FILE, JSON.stringify(list, null, 2)); } catch {}
}
function flush() {
  for (const s of sessions.values())
    if (s.sbDirty) try { fs.writeFileSync(sbFile(s.id), s.scrollback); } catch {}
  persist();
}
function list() {
  return [...sessions.values()].map((s) => ({
    id: s.id, name: s.name, shell: s.shell, cwd: s.cwd,
    workspace: s.workspace, createdAt: s.createdAt, exited: s.exited,
  }));
}
const conns = new Set();
function bcast(o) {
  const l = JSON.stringify(o) + "\n";
  for (const c of conns) try { c.write(l); } catch {}
}

// node-pty reports a bad cwd (win error 267) asynchronously from a worker,
// which try/catch can't see and which kills the whole host — so only ever
// hand it an absolute directory that exists right now
function safeCwd(cwd) {
  try {
    if (cwd && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return os.homedir();
}

function spawnProc(s) {
  const sh = SHELLS[s.shell] || SHELLS.powershell || Object.values(SHELLS)[0];
  s.proc = pty.spawn(sh.path, sh.args, {
    name: "xterm-256color", cols: s.cols || 120, rows: s.rows || 32, cwd: safeCwd(s.cwd),
    env: cleanEnv(),
  });
  s.exited = false;
  s.modes = {};
  s.proc.onData((d) => {
    trackModes(s.modes, d);
    s.scrollback = Buffer.concat([s.scrollback, Buffer.from(d, "utf8")]).subarray(-SCROLLBACK_MAX);
    s.sbDirty = true;
    bcast({ op: "out", id: s.id, data: d });
  });
  s.proc.onExit(({ exitCode }) => {
    s.exited = true;
    s.proc = null;
    try { fs.writeFileSync(sbFile(s.id), s.scrollback); } catch {}
    s.sbDirty = false;
    persist();
    bcast({ op: "exit", id: s.id, code: exitCode });
    bcast({ op: "sessions", list: list() });
  });
}

function create(m) {
  if (sessions.has(m.id)) return;
  const s = {
    id: m.id, name: m.name || m.shell || "shell", shell: m.shell, cwd: m.cwd,
    workspace: m.workspace || null, cols: m.cols || 120, rows: m.rows || 32,
    createdAt: m.createdAt || Date.now(), exited: false,
    proc: null, scrollback: Buffer.alloc(0), sbDirty: false,
  };
  sessions.set(s.id, s);
  try { spawnProc(s); } catch (e) { s.exited = true; log("spawn failed", s.id, e.message); }
  persist();
  bcast({ op: "created", id: s.id });
  bcast({ op: "sessions", list: list() });
}

function kill(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc && s.proc.kill(); } catch {}
  sessions.delete(id);
  try { fs.rmSync(sbFile(id), { force: true }); } catch {}
  persist();
  bcast({ op: "sessions", list: list() });
}

function attach(m, conn) {
  const s = sessions.get(m.id);
  if (!s) return conn.write(JSON.stringify({ op: "attached", id: m.id, tok: m.tok, data: "", gone: true }) + "\n");
  if (m.cols && s.proc && !s.exited) { try { s.proc.resize(m.cols, m.rows); } catch {} }
  if (s.exited || !s.proc) {
    if (fs.existsSync(s.cwd)) {
      s.scrollback = Buffer.concat([s.scrollback, Buffer.from(RESTORE_MARK)]).subarray(-SCROLLBACK_MAX);
      s.sbDirty = true;
      try { spawnProc(s); persist(); bcast({ op: "sessions", list: list() }); } catch {}
    }
  }
  conn.write(JSON.stringify({
    op: "attached", id: m.id, tok: m.tok, exited: s.exited,
    data: replayData(s),
  }) + "\n");
}

function restore() {
  let recs = [];
  try { recs = JSON.parse(fs.readFileSync(SESS_FILE, "utf8")); } catch {}
  if (!recs.length) { // one-time migration: sessions lived in state.json pre-broker
    try { recs = (JSON.parse(fs.readFileSync(LEGACY_STATE, "utf8")).sessions) || []; } catch {}
  }
  for (const rec of recs) {
    if (!rec.id || sessions.has(rec.id)) continue;
    const s = {
      ...rec, proc: null, sbDirty: false,
      scrollback: (() => { try { return fs.readFileSync(sbFile(rec.id)); } catch { return Buffer.alloc(0); } })(),
    };
    sessions.set(s.id, s);
    if (!rec.exited && fs.existsSync(s.cwd)) {
      s.scrollback = Buffer.concat([s.scrollback, Buffer.from(RESTORE_MARK)]).subarray(-SCROLLBACK_MAX);
      s.sbDirty = true;
      try { spawnProc(s); } catch { s.exited = true; }
    }
  }
}

// ---------- socket ----------
if (!IS_WIN) try { fs.rmSync(HOST_ADDR, { force: true }); } catch {}
const srv = net.createServer((conn) => {
  conns.add(conn);
  conn.write(JSON.stringify({ op: "ready", user: os.userInfo().username }) + "\n");
  conn.write(JSON.stringify({ op: "sessions", list: list() }) + "\n");
  let buf = "";
  conn.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      try {
        switch (m.op) {
          case "create": create(m); break;
          case "attach": attach(m, conn); break;
          case "in": { const s = sessions.get(m.id); if (s && s.proc && !s.exited) s.proc.write(m.data); break; }
          case "resize": { const s = sessions.get(m.id); if (s && s.proc && !s.exited) { try { s.proc.resize(m.cols, m.rows); } catch {} } break; }
          case "kill": kill(m.id); break;
          case "rename": { const s = sessions.get(m.id); if (s && m.name) { s.name = String(m.name).slice(0, 60); persist(); bcast({ op: "sessions", list: list() }); } break; }
          case "list": conn.write(JSON.stringify({ op: "sessions", list: list() }) + "\n"); break;
          case "ping": conn.write(JSON.stringify({ op: "pong" }) + "\n"); break;
          // broker runs as SYSTEM before logon and spawns a SYSTEM host so
          // pre-login terminals work; once a user agent is up it asks us to
          // hand over — persist, release the pipe, and let the user's own
          // host respawn the sessions in-session (scrollback keeps the view)
          case "shutdown": setImmediate(() => { flush(); process.exit(0); }); break;
        }
      } catch (e) { log("op error", m.op, e.message); }
    }
  });
  conn.on("close", () => conns.delete(conn));
  conn.on("error", () => conns.delete(conn));
});
srv.on("error", (e) => { log("listen failed:", e.message); process.exit(1); });
srv.listen(HOST_ADDR, () => log("listening on", HOST_ADDR));

restore();
persist();
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.sbDirty) continue;
    try { fs.writeFileSync(sbFile(s.id), s.scrollback); } catch {}
    s.sbDirty = false;
  }
}, 3000);
// one bad pty must not take every other terminal down with it
process.on("uncaughtException", (e) => { log("uncaught:", e && e.message); });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { flush(); process.exit(0); });
}
log("restored", sessions.size, "session(s)");
