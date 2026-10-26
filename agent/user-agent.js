// S-remote user agent — one per interactive logon session (spawned by the
// tray at logon). Gives the SYSTEM broker (server.js running as a service)
// hands inside this session:
//   * keeps agent/session-host.js alive here, so PTYs run as this user
//   * relays screen-capture agents (they must run in-session to see the
//     desktop — Session 0 services can't)
// Talks JSONL over loopback TCP to the broker; auth is a shared key file
// readable by this user (data/agent.key).
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const HOST_JS = path.join(ROOT, "agent", "session-host.js");
const KEY_FILE = path.join(DATA_DIR, "agent.key");
const PORT = Number(process.env.SREMOTE_AGENT_PORT || 2210);
const HOST_ADDR = "\\\\.\\pipe\\sremote-sessions-" +
  require("crypto").createHash("sha1").update(ROOT.toLowerCase()).digest("hex").slice(0, 10);

const LOG = path.join(DATA_DIR, "agent.log");
function log(...a) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(" ")}\n`);
  } catch {}
}
process.on("uncaughtException", (e) => log("uncaught:", e.stack || e));
process.on("unhandledRejection", (e) => log("unhandled:", String(e)));

// ---------- session host (PTYs) ----------
let hostSpawned = false, hostSpawnT = 0;
function hostAlive(cb) {
  const c = net.connect(HOST_ADDR);
  c.once("connect", () => { c.destroy(); cb(true); });
  c.once("error", () => cb(false));
  setTimeout(() => { try { c.destroy(); } catch {} }, 1500);
}
function ensureHost() {
  hostAlive((up) => {
    if (up) return;
    if (Date.now() - hostSpawnT < 5000) return;  // someone is already trying
    hostSpawnT = Date.now();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const logFd = fs.openSync(path.join(DATA_DIR, "host.log"), "a");
      const p = spawn(process.execPath, [HOST_JS],
        { detached: true, stdio: ["ignore", "ignore", logFd], windowsHide: true, cwd: ROOT });
      p.on("exit", () => { hostSpawned = false; });
      p.unref();
      hostSpawned = true;
      log("session host spawned pid", p.pid);
    } catch (e) { log("host spawn failed:", e.message); }
  });
}

// ---------- broker link ----------
let sock = null, buf = "", authd = false;
const procs = new Map(); // id -> child_process
function send(o) { if (sock && sock.writable) sock.write(JSON.stringify(o) + "\n"); }
function killAll() {
  for (const p of procs.values()) { try { p.kill(); } catch {} }
  procs.clear();
}

function onMsg(m) {
  switch (m.op) {
    case "hello-ok":
      authd = true;
      log("broker accepted");
      break;
    case "ensure-host":
      ensureHost();
      break;
    case "spawn": {
      if (procs.size > 32) return send({ op: "err", id: m.id, msg: "too many procs" });
      try {
        const p = spawn(m.exe, m.args || [], {
          stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
          cwd: m.cwd && fs.existsSync(m.cwd) ? m.cwd : ROOT,
        });
        procs.set(m.id, p);
        p.stdout.on("data", (d) => send({ op: "data", id: m.id, b64: d.toString("base64") }));
        p.on("exit", (code) => { procs.delete(m.id); send({ op: "exit", id: m.id, code }); });
        p.on("error", (e) => { procs.delete(m.id); send({ op: "exit", id: m.id, code: -1, msg: e.message }); });
        log("spawn", m.id, m.exe);
      } catch (e) { send({ op: "exit", id: m.id, code: -1, msg: e.message }); }
      break;
    }
    case "stdin": {
      const p = procs.get(m.id);
      if (p && p.stdin.writable)
        try { p.stdin.write(Buffer.from(m.data, "base64")); } catch {}
      break;
    }
    case "kill": {
      const p = procs.get(m.id);
      if (p) try { p.kill(); } catch {}
      break;
    }
    case "ping": send({ op: "pong" }); break;
  }
}

function connect() {
  if (sock) return;
  const c = net.connect(PORT, "127.0.0.1");
  sock = c; buf = ""; authd = false;
  c.on("connect", () => {
    let key = "";
    try { key = fs.readFileSync(KEY_FILE, "utf8").trim(); } catch {}
    send({
      op: "hello", key, user: os.userInfo().username,
      sess: process.env.SESSIONNAME || "", pid: process.pid,
    });
  });
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      try { onMsg(m); } catch (e) { log("op error", m.op, e.message); }
    }
  });
  const drop = () => {
    if (sock === c) sock = null;
    killAll();           // screen procs die with the link; broker respawns on resub
    setTimeout(connect, 2000);
  };
  c.on("error", () => {});
  c.on("close", drop);
}
connect();
ensureHost();          // PTYs useful even before/without a broker link
setInterval(() => { ensureHost(); }, 30000);   // cheap keep-alive for the broker's PTYs

// the tray watches this file to respawn us when we die
const PID_FILE = path.join(DATA_DIR,
  `agent-${os.userInfo().username}-${process.env.SESSIONNAME || "x"}.pid`);
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}

log("user agent started pid", process.pid, "user", os.userInfo().username);
