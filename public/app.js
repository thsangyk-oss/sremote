/* remote-direct client — terminal UI over direct WS */
"use strict";

const $ = (s) => document.querySelector(s);

// ---------- state ----------
let ws = null, wsAlive = false, reconnectTimer = null;
let sessions = [];          // all server sessions
let workspaces = [];        // persisted workspace folders
let activeId = null;
let view = "home";          // 'home' | 'work'
let currentWs = undefined;  // workspace id | null (standalone) | undefined (home)
const panes = new Map();    // id -> {term, fit, el, attached}
let hostInfo = {};

const sessListEl = $("#sess-list"), tabsEl = $("#tabs"), termsEl = $("#terms");
const emptyEl = $("#empty"), sidebar = $("#sidebar"), filesPanel = $("#filespanel");
const wsGridEl = $("#ws-grid"), homeSessEl = $("#home-sessions");

// ---------- toasts ----------
function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast" + (kind === "err" ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, 3200);
}

// touch devices get the keybar; drawer/scrim layout follows viewport width —
// a desktop with a touchscreen is coarse but NOT narrow. Some mobile browsers
// misreport pointer:coarse, so the keybar also shows on narrow screens.
const isCoarse = matchMedia("(pointer: coarse)").matches;
const mqNarrow = matchMedia("(max-width: 720px)");
function syncTouchUI() { document.body.classList.toggle("touch-ui", isCoarse || mqNarrow.matches); }
syncTouchUI();
const mqHandler = () => { syncTouchUI(); applyToggles(); };
if (mqNarrow.addEventListener) mqNarrow.addEventListener("change", mqHandler);
else if (mqNarrow.addListener) mqNarrow.addListener(mqHandler); // iOS < 14

// ---------- helpers ----------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(1) + " GB";
}
const wsById = (id) => workspaces.find((w) => w.id === id);
const sessInView = () => sessions.filter((s) => (s.workspace || null) === (currentWs ?? null));

// ---------- websocket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    wsAlive = true;
    setConn(true);
    send({ type: "list" });
    for (const [id, p] of panes) attach(id, p);
    pingLoop();
  };
  ws.onclose = () => {
    wsAlive = false;
    setConn(false);
    for (const p of panes.values()) p.attached = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "sessions":
        sessions = m.list;
        renderAll();
        if (view === "work" && !inView(activeId)) {
          const vis = sessInView().filter((s) => !s.exited);
          const pick = vis[0] || sessInView()[0];
          if (pick) select(pick.id); else { activeId = null; updateEmpty(); renderTabs(); }
        }
        break;
      case "out": {
        const p = panes.get(m.id);
        if (p) p.term.write(m.data);
        break;
      }
      case "attached": {
        const p = panes.get(m.id);
        if (p) { p.attached = true; sendSize(m.id, p); }
        break;
      }
      case "exit": {
        const p = panes.get(m.id);
        if (p) p.term.write(`\r\n\x1b[90m[process exited ${m.code}]\x1b[0m\r\n`);
        break;
      }
      case "created": {
        // tag the new session into the current workspace client-side happens server-side
        select(m.id);
        break;
      }
      case "pong":
        for (const el of [$("#latency"), $("#latency2")]) if (el) el.textContent = `${Date.now() - m.t}ms`;
        break;
    }
  };
}
const inView = (id) => { const s = sessions.find((x) => x.id === id); return s && (s.workspace || null) === (currentWs ?? null); };
function send(o) { if (wsAlive) ws.send(JSON.stringify(o)); }
function setConn(up) {
  document.body.classList.toggle("disconnected", !up);
  for (const [d, t] of [[$("#conn-dot"), $("#conn-text")], [$("#conn-dot2"), $("#conn-text2")]]) {
    if (d) { d.className = "dot " + (up ? "up" : "down"); }
    if (t) t.textContent = up ? "direct" : "reconnecting…";
  }
  if (!up) for (const el of [$("#latency"), $("#latency2")]) if (el) el.textContent = "";
}
let pingTimer = null;
function pingLoop() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => send({ type: "ping", t: Date.now() }), 3000);
}

// ---------- views ----------
function showView(v) {
  view = v;
  $("#view-home").classList.toggle("hidden", v !== "home");
  $("#view-work").classList.toggle("hidden", v !== "work");
  if (v === "work") renderAll();
}
function enterWorkspace(wsId) {
  currentWs = wsId;            // id | null (standalone)
  const w = wsId ? wsById(wsId) : null;
  $("#ws-title").innerHTML = w
    ? `<span class="wt-name">${folderSvg(16)} ${esc(w.name)}</span><span class="wt-path">${esc(w.path)}</span>`
    : `<span class="wt-name">Standalone</span><span class="wt-path">no workspace</span>`;
  showView("work");
  if (mqNarrow.matches) { sideVisible = false; fpVisible = false; applyToggles(); } // drawers start closed on narrow screens
  fpRoot = w ? `ws:${w.id}` : null;
  fpPath = "";
  // pick a session in this workspace
  const vis = sessInView().filter((s) => !s.exited);
  const pick = vis[0] || sessInView()[0];
  activeId = null;
  if (pick) select(pick.id); else updateEmpty();
  renderAll();
  if (fpVisible && fpRoot) fpNavigate("");
}
function goHome() {
  view = "home";
  activeId = null;             // sessions keep running; panes stay attached
  for (const p of panes.values()) p.el.classList.add("hidden");
  showView("home");
}
$("#home-btn").onclick = goHome;

// ---------- sessions / panes ----------
function ensurePane(id) {
  let p = panes.get(id);
  if (p) return p;
  const el = document.createElement("div");
  el.className = "term-pane hidden";
  termsEl.appendChild(el);
  const term = new Terminal({
    fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
    fontSize: 14, cursorBlink: true, scrollback: 5000,
    theme: { background: "#0d1117", foreground: "#e6edf3" },
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((d) => send({ type: "in", id, data: d }));
  term.onResize(({ cols, rows }) => send({ type: "resize", id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "V") { navigator.clipboard.readText().then((t) => send({ type: "in", id, data: t })); return false; }
    return true;
  });
  p = { term, fit, el, attached: false };
  panes.set(id, p);
  el.addEventListener("touchstart", () => term.focus(), { passive: true }); // open keyboard on tap
  return p;
}
function attach(id, p) {
  send({ type: "attach", id, cols: p.term.cols, rows: p.term.rows });
}
function sendSize(id, p) {
  try { p.fit.fit(); } catch {}
  send({ type: "resize", id, cols: p.term.cols, rows: p.term.rows });
}
function select(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  activeId = id;
  if (mqNarrow.matches && sideVisible) { sideVisible = false; applyToggles(); } // auto-close drawer on narrow screens
  const p = ensurePane(id);
  for (const [pid, pp] of panes) pp.el.classList.toggle("hidden", pid !== id);
  p.term.clear();
  if (wsAlive) attach(id, p);
  renderTabs(); renderSessions(); updateEmpty();
  requestAnimationFrame(() => { sendSize(id, p); p.term.focus(); });
  // standalone view: files follow session cwd
  if (!currentWs && s.cwd) { fpRoot = s.cwd; if (fpVisible) fpNavigate(""); }
}
function closeSession(id) {
  send({ type: "kill", id });
  const p = panes.get(id);
  if (p) { p.term.dispose(); p.el.remove(); panes.delete(id); }
  if (activeId === id) {
    activeId = null;
    const rest = sessInView().filter((s) => s.id !== id);
    if (rest.length) select(rest[0].id); else updateEmpty();
  }
}
function renameSession(id) {
  const s = sessions.find((x) => x.id === id);
  const t = tabsEl.querySelector(`[data-id="${id}"]`);
  if (!s || !t) return;
  const inp = document.createElement("input");
  inp.className = "tab-rename"; inp.value = s.name;
  t.replaceWith(inp);
  inp.focus(); inp.select();
  const done = (commit) => {
    if (commit && inp.value.trim() && inp.value.trim() !== s.name)
      send({ type: "rename", id, name: inp.value.trim() });
    renderTabs();
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
  inp.onblur = () => done(true);
}

// ---------- rendering ----------
function renderAll() {
  renderSessions(); renderTabs(); renderHome(); updateEmpty();
}
function renderSessions() {
  sessListEl.innerHTML = "";
  for (const s of sessInView()) {
    const d = document.createElement("div");
    d.className = "sess-item" + (s.id === activeId ? " active" : "") + (s.exited ? " exited" : "");
    d.innerHTML = `<span class="sess-dot"></span><span class="sess-txt"><span class="sess-name">${esc(s.name)}</span><span class="sess-cwd">${esc(shortPath(s.cwd))}</span></span>`;
    d.onclick = () => select(s.id);
    sessListEl.appendChild(d);
  }
}
function renderTabs() {
  tabsEl.innerHTML = "";
  for (const s of sessInView()) {
    if (!panes.has(s.id)) continue;
    const t = document.createElement("div");
    t.className = "tab" + (s.id === activeId ? " active" : "") + (s.exited ? " exited" : "");
    t.dataset.id = s.id;
    t.innerHTML = `<span>${esc(s.name)}</span><span class="tab-x" title="kill">×</span>`;
    t.onclick = (e) => { if (e.target.classList.contains("tab-x")) closeSession(s.id); else select(s.id); };
    t.ondblclick = () => renameSession(s.id);
    tabsEl.appendChild(t);
  }
}
function renderHome() {
  // workspace cards
  wsGridEl.innerHTML = "";
  const sorted = [...workspaces].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  for (const w of sorted) {
    const n = sessions.filter((s) => s.workspace === w.id && !s.exited).length;
    const d = document.createElement("div");
    d.className = "ws-card";
    d.innerHTML = `<div class="ws-card-ico">${folderSvg(34)}</div>
      <div class="ws-card-name">${esc(w.name)}</div>
      <div class="ws-card-path">${esc(w.path)}</div>
      <div class="ws-card-meta">${n ? `${n} live session${n > 1 ? "s" : ""}` : "idle"}</div>
      <span class="ws-x" title="Remove">×</span>`;
    d.onclick = (e) => {
      if (e.target.classList.contains("ws-x")) {
        fetch(`/api/workspaces/${w.id}`, { method: "DELETE" })
          .then((r) => { if (r.ok) { toast(`Removed workspace “${w.name}”`); loadWorkspaces(); } });
      } else enterWorkspace(w.id);
    };
    wsGridEl.appendChild(d);
  }
  const add = document.createElement("div");
  add.className = "ws-card ws-add";
  add.innerHTML = `<div class="ws-add-plus">+</div><div class="ws-card-name">Add workspace</div>`;
  add.onclick = () => openPicker((p) => {
    fetch("/api/workspaces", { method: "POST", body: JSON.stringify({ path: p }) })
      .then((r) => r.json()).then((w) => { toast(`Workspace “${w.name}” added`); loadWorkspaces(); });
  });
  wsGridEl.appendChild(add);
  // all sessions
  homeSessEl.innerHTML = "";
  if (!sessions.length) homeSessEl.innerHTML = `<div class="home-none">No sessions yet — open a workspace to start one.</div>`;
  for (const s of sessions) {
    const w = s.workspace ? wsById(s.workspace) : null;
    const d = document.createElement("div");
    d.className = "home-sess" + (s.exited ? " exited" : "");
    d.innerHTML = `<span class="hs-state ${s.exited ? "off" : "on"}"></span>
      <span class="hs-name">${esc(s.name)}</span>
      <span class="hs-ws">${w ? esc(w.name) : "standalone"}</span>
      <span class="hs-cwd">${esc(shortPath(s.cwd))}</span>
      <span class="ws-x" title="Kill">×</span>`;
    d.onclick = (e) => {
      if (e.target.classList.contains("ws-x")) { send({ type: "kill", id: s.id }); toast(`Killed “${s.name}”`); return; }
      enterWorkspace(s.workspace || null);
      setTimeout(() => select(s.id), 0);
    };
    homeSessEl.appendChild(d);
  }
}
function updateEmpty() {
  emptyEl.classList.toggle("hidden", !!activeId && panes.has(activeId));
}

// ---------- workspaces ----------
async function loadWorkspaces() {
  workspaces = await fetch("/api/workspaces").then((r) => r.json()).catch(() => []);
  renderAll();
}

// ---------- sidebar / files panel toggles ----------
let fpVisible = localStorage.getItem("rd.files") !== "0";
let sideVisible = localStorage.getItem("rd.sidebar") !== "0";
function applyToggles() {
  sidebar.classList.toggle("hidden", !sideVisible);
  $("#rail-open").classList.toggle("hidden", sideVisible);
  filesPanel.classList.toggle("hidden", !fpVisible);
  $("#files-toggle").classList.toggle("on", fpVisible);
  $("#scrim").classList.toggle("show", mqNarrow.matches && (sideVisible || fpVisible));
  applyWidths();
  if (fpVisible && fpRoot) fpNavigate(fpPath);
  const p = panes.get(activeId);
  if (p) requestAnimationFrame(() => sendSize(activeId, p));
}
$("#side-collapse").onclick = () => { sideVisible = false; localStorage.setItem("rd.sidebar", "0"); applyToggles(); };
$("#rail-open").onclick = () => { sideVisible = true; localStorage.setItem("rd.sidebar", "1"); applyToggles(); };
$("#files-toggle").onclick = () => { fpVisible = !fpVisible; localStorage.setItem("rd.files", fpVisible ? "1" : "0"); applyToggles(); };
$("#fp-close").onclick = () => { fpVisible = false; localStorage.setItem("rd.files", "0"); applyToggles(); };

// ---------- drag resizers ----------
function applyWidths() {
  const sw = localStorage.getItem("rd.w.side"), fw = localStorage.getItem("rd.w.files");
  if (sw) sidebar.style.width = sw + "px";
  if (fw) filesPanel.style.width = fw + "px";
}
function makeResizable(handle, panel, min, max, key, fromRight) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("drag");
    document.body.classList.add("dragging");
    const startX = e.clientX, startW = panel.offsetWidth;
    const move = (ev) => {
      const dx = fromRight ? startX - ev.clientX : ev.clientX - startX;
      const w = Math.min(max, Math.max(min, startW + dx));
      panel.style.width = w + "px";
      localStorage.setItem(key, w);
    };
    const up = () => {
      handle.classList.remove("drag");
      document.body.classList.remove("dragging");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const p = panes.get(activeId);
      if (p && activeId) sendSize(activeId, p);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
makeResizable($("#rs-side"), sidebar, 170, 400, "rd.w.side", false);
makeResizable($("#rs-files"), filesPanel, 190, 480, "rd.w.files", true);

// ---------- mobile keybar (Esc/Tab/Ctrl/arrows…) ----------
let ctrlLatch = false, altLatch = false;
const KEYBAR = [
  { l: "Esc", d: "\x1b" }, { l: "Tab", d: "\t" }, { l: "Ctrl", mod: "ctrl" }, { l: "Alt", mod: "alt" },
  { l: "←", d: "\x1b[D" }, { l: "↓", d: "\x1b[B" }, { l: "↑", d: "\x1b[A" }, { l: "→", d: "\x1b[C" },
  { l: "|", d: "|" }, { l: "~", d: "~" }, { l: "-", d: "-" }, { l: "/", d: "/" },
  { l: "C-c", d: "\x03" }, { l: "C-z", d: "\x1a" }, { l: "C-d", d: "\x04" }, { l: "C-l", d: "\x0c" },
];
function sendKey(def) {
  if (!activeId) return;
  let data = def.d;
  if (ctrlLatch) {
    if (/^[a-z]$/i.test(def.d)) data = String.fromCharCode(def.d.toUpperCase().charCodeAt(0) & 0x1f);
    ctrlLatch = false; syncLatch();
  }
  if (altLatch) { data = "\x1b" + data; altLatch = false; syncLatch(); }
  send({ type: "in", id: activeId, data });
}
function syncLatch() {
  document.querySelectorAll("#keybar .kb-mod").forEach((b) => {
    b.classList.toggle("latched", (b.dataset.mod === "ctrl" && ctrlLatch) || (b.dataset.mod === "alt" && altLatch));
  });
}
(function buildKeybar() {
  const kb = $("#keybar");
  for (const k of KEYBAR) {
    const b = document.createElement("button");
    b.className = "kb-key" + (k.mod ? " kb-mod" : "");
    b.textContent = k.l;
    if (k.mod) b.dataset.mod = k.mod;
    b.addEventListener("click", () => {
      const ae = document.activeElement;
      if (ae && ae.blur) ae.blur(); // hide soft keyboard — keybar replaces it
      if (k.mod === "ctrl") { ctrlLatch = !ctrlLatch; syncLatch(); return; }
      if (k.mod === "alt") { altLatch = !altLatch; syncLatch(); return; }
      sendKey(k);
    });
    kb.appendChild(b);
  }
})();

// ---------- type row (buffered input → terminal) ----------
const typer = $("#typer");
function typerSend(withEnter) {
  const v = typer.value;
  if (!activeId) return;
  if (v) send({ type: "in", id: activeId, data: v + (withEnter ? "\r" : "") });
  else if (withEnter) send({ type: "in", id: activeId, data: "\r" });
  typer.value = "";
  typer.focus();
}
$("#typer-send").onclick = () => typerSend(true);
$("#typer-raw").onclick = () => typerSend(false);
typer.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); typerSend(true); }
  e.stopPropagation(); // don't hit global shortcuts while typing
});
// attach file → upload into workspace's temp-upload/ → path into input
$("#typer-attach").onclick = () => $("#attach-file").click();
$("#attach-file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (!fpRoot) return toast("Open a workspace or session first", "err");
  try {
    const r = await fetch(`/api/upload?base=${encodeURIComponent(fpRoot)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return toast("Upload failed: " + (j?.error || r.status), "err");
    const p = /\s/.test(j.path) ? `"${j.path}"` : j.path;
    typer.value = typer.value && !typer.value.endsWith(" ") ? `${typer.value} ${p}` : typer.value + p;
    typer.focus();
    toast(`Attached → ${j.rel}`);
    if (fpVisible && fpRoot) fpNavigate(fpPath);
  } catch { toast("Upload failed", "err"); }
});

// ---------- scrim (mobile drawers) ----------
$("#scrim").onclick = () => {
  if (sideVisible) { sideVisible = false; }
  if (fpVisible) { fpVisible = false; }
  applyToggles();
};

// ---------- keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    for (const m of ["#new-modal", "#picker", "#file-modal"]) $(m).classList.add("hidden");
    return;
  }
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  if (e.key === "b" || e.key === "B") { // Ctrl+B sidebar
    if (view !== "work") return;
    sideVisible = !sideVisible; localStorage.setItem("rd.sidebar", sideVisible ? "1" : "0"); applyToggles();
    e.preventDefault();
  } else if (e.key === "j" || e.key === "J") { // Ctrl+J files
    if (view !== "work") return;
    fpVisible = !fpVisible; localStorage.setItem("rd.files", fpVisible ? "1" : "0"); applyToggles();
    e.preventDefault();
  } else if (e.key === "`") { // Ctrl+` new terminal
    if (view !== "work") return;
    openModal();
    e.preventDefault();
  }
});

// ---------- files panel ----------
let fpRoot = null, fpPath = "";
const fpList = $("#fp-list"), fpCrumbs = $("#fp-crumbs");
function fileSvg() {
  return `<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M5 2h6l4 4v12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 18V3.5A1.5 1.5 0 0 1 5.5 2z" fill="#7d8fa3" opacity=".85"/><path d="M11 2l4 4h-4V2z" fill="#aeb9c6"/></svg>`;
}
async function fpNavigate(rel) {
  if (!fpRoot) return;
  const r = await fetch(`/api/files?base=${encodeURIComponent(fpRoot)}&path=${encodeURIComponent(rel)}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) { fpList.innerHTML = `<div class="fp-err">${esc(j?.error || "unreadable")}</div>`; return; }
  fpPath = j.path;
  // breadcrumbs
  fpCrumbs.innerHTML = "";
  const root = document.createElement("span");
  root.className = "pk-crumb"; root.textContent = "root";
  root.onclick = () => fpNavigate("");
  fpCrumbs.appendChild(root);
  if (j.path) {
    let acc = "";
    for (const seg of j.path.split(/[\\/]/)) {
      acc = acc ? acc + "/" + seg : seg;
      const sep = document.createElement("span"); sep.className = "pk-sep"; sep.textContent = "›";
      const c = document.createElement("span"); c.className = "pk-crumb"; c.textContent = seg;
      const t = acc; c.onclick = () => fpNavigate(t);
      fpCrumbs.appendChild(sep); fpCrumbs.appendChild(c);
    }
  }
  // items
  fpList.innerHTML = "";
  if (j.parent !== null) {
    const up = document.createElement("div");
    up.className = "fp-item";
    up.innerHTML = `<span class="fp-ico">${folderSvg(15)}</span><span class="fp-name">..</span>`;
    up.onclick = () => fpNavigate(j.parent);
    fpList.appendChild(up);
  }
  for (const it of j.items) {
    const d = document.createElement("div");
    d.className = "fp-item" + (it.dir ? " dir" : "");
    d.innerHTML = `<span class="fp-ico">${it.dir ? folderSvg(15) : fileSvg()}</span>
      <span class="fp-name" title="${esc(it.name)}">${esc(it.name)}</span>
      <span class="fp-size">${it.dir ? "" : fmtSize(it.size)}</span>`;
    const rel = j.path ? j.path + "/" + it.name : it.name;
    if (it.dir) d.onclick = () => fpNavigate(rel);
    else d.onclick = () => openFile(rel, it);
    fpList.appendChild(d);
  }
  if (!j.items.length && j.parent === null) fpList.innerHTML = `<div class="fp-err">Empty folder</div>`;
}
$("#fp-refresh").onclick = () => fpNavigate(fpPath);

// ---------- file preview ----------
const fileModal = $("#file-modal");
async function openFile(rel, it) {
  const url = `/api/file?base=${encodeURIComponent(fpRoot)}&path=${encodeURIComponent(rel)}`;
  $("#file-name").textContent = it.name;
  const dl = $("#file-dl");
  dl.href = url + "&dl=1";
  dl.download = it.name;
  $("#file-body").textContent = "loading…";
  fileModal.classList.remove("hidden");
  try {
    const r = await fetch(url + "&head=1");
    const size = Number(r.headers.get("X-File-Size") || it.size);
    const buf = await r.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const printable = !/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 4000));
    $("#file-body").textContent = printable
      ? text + (size > buf.byteLength ? `\n\n… truncated (${fmtSize(size)} total — use Download)` : "")
      : `Binary file — ${fmtSize(size)}. Use Download.`;
  } catch (e) { $("#file-body").textContent = "Failed to load: " + e.message; }
}
$("#file-close").onclick = () => fileModal.classList.add("hidden");
fileModal.onclick = (e) => e.target === fileModal && fileModal.classList.add("hidden");

// ---------- folder picker (Win11 style) ----------
const picker = $("#picker"), pkMain = $("#pk-main"), pkCrumbs = $("#pk-crumbs"),
      pkQuick = $("#pk-quick"), pkSel = $("#pk-selected"), pkOk = $("#pk-ok");
let pkPath = "", pkHist = [""], pkHi = 0, pkItems = [], pkCb = null, pkSelectedPath = null;

function folderSvg(sz = 20) {
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20" fill="none"><path d="M2 5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8L10 5h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5z" fill="#f7d774"/><path d="M2 7h16v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7z" fill="#fcd669"/></svg>`;
}
function driveSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="6" width="16" height="8" rx="1.5" fill="#4a6fa5"/><rect x="3.5" y="7.5" width="13" height="5" rx="1" fill="#6e93c9"/><circle cx="15.5" cy="10" r="1" fill="#0d1117"/></svg>`;
}
function openPicker(cb) {
  pkCb = cb; pkSelectedPath = null; pkSel.value = ""; pkOk.disabled = true;
  pkHist = [""]; pkHi = 0;
  picker.classList.remove("hidden");
  pkNavigate("");
}
function pkNavigate(p, push = true) {
  fetch(`/api/browse?path=${encodeURIComponent(p)}`)
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) { pkMain.innerHTML = `<div class="pk-err">Can't open: ${esc(j.error || "?")}</div>`; return; }
      pkPath = j.path; pkItems = j.items;
      if (push) { pkHist = pkHist.slice(0, pkHi + 1); pkHist.push(pkPath); pkHi++; }
      renderPicker(j);
    });
}
function renderPicker(j) {
  pkCrumbs.innerHTML = "";
  const root = document.createElement("span");
  root.className = "pk-crumb"; root.textContent = "This PC";
  root.onclick = () => pkNavigate("");
  pkCrumbs.appendChild(root);
  if (j.path) {
    const parts = j.path.replace(/[\\/]+$/, "").split(/[\\/]+/);
    let acc = j.path.startsWith("\\\\") ? "\\\\" : "";
    parts.forEach((seg, i) => {
      acc = i === 0 ? seg + "\\" : acc.replace(/\\$/, "") + "\\" + seg;
      const sep = document.createElement("span"); sep.className = "pk-sep"; sep.textContent = "›";
      const c = document.createElement("span"); c.className = "pk-crumb"; c.textContent = seg;
      const target = i === 0 && /^[A-Z]:$/i.test(seg) ? seg + "\\" : acc;
      c.onclick = () => pkNavigate(target);
      pkCrumbs.appendChild(sep); pkCrumbs.appendChild(c);
    });
  }
  pkQuick.innerHTML = "";
  for (const q of j.quickAccess || []) {
    const d = document.createElement("div");
    d.className = "pk-quick-item" + (q.path === pkPath ? " sel" : "");
    d.innerHTML = `${folderSvg(16)} ${esc(q.name)}`;
    d.onclick = () => pkNavigate(q.path);
    pkQuick.appendChild(d);
  }
  const pc = document.createElement("div");
  pc.className = "pk-quick-item" + (pkPath === "" ? " sel" : "");
  pc.innerHTML = `${driveSvg()} This PC`;
  pc.onclick = () => pkNavigate("");
  pkQuick.appendChild(pc);
  pkMain.innerHTML = "";
  if (!j.items.length) pkMain.innerHTML = `<div class="pk-err">This folder is empty</div>`;
  for (const it of j.items) {
    const d = document.createElement("div");
    d.className = "pk-item" + (it.path === pkSelectedPath ? " sel" : "");
    d.innerHTML = `<span class="pk-ico">${it.drive ? driveSvg() : folderSvg()}</span><span class="pk-name">${esc(it.name)}</span>`;
    d.onclick = () => {
      pkSelectedPath = it.path; pkSel.value = it.path; pkOk.disabled = false;
      pkMain.querySelectorAll(".pk-item.sel").forEach((x) => x.classList.remove("sel"));
      d.classList.add("sel");
    };
    d.ondblclick = () => pkNavigate(it.path);
    pkMain.appendChild(d);
  }
}
$("#pk-back").onclick = () => { if (pkHi > 0) { pkHi--; pkNavigate(pkHist[pkHi], false); } };
$("#pk-fwd").onclick = () => { if (pkHi < pkHist.length - 1) { pkHi++; pkNavigate(pkHist[pkHi], false); } };
$("#pk-up").onclick = () => {
  fetch(`/api/browse?path=${encodeURIComponent(pkPath)}`).then((r) => r.json()).then((j) => pkNavigate(j.parent ?? ""));
};
$("#pk-refresh").onclick = () => pkNavigate(pkPath, false);
$("#pk-cancel").onclick = () => picker.classList.add("hidden");
picker.onclick = (e) => e.target === picker && picker.classList.add("hidden");
$("#pk-ok").onclick = () => {
  if (!pkSelectedPath || !pkCb) return;
  const cb = pkCb; pkCb = null;
  picker.classList.add("hidden");
  cb(pkSelectedPath);
};
$("#pk-newfolder").onclick = () => {
  if (!pkPath) return;
  const row = document.createElement("div");
  row.className = "pk-item pk-newfold";
  row.innerHTML = `<span class="pk-ico">${folderSvg()}</span>`;
  const inp = document.createElement("input");
  inp.placeholder = "New folder"; inp.autofocus = true;
  row.appendChild(inp);
  pkMain.prepend(row);
  inp.focus();
  inp.onkeydown = (e) => {
    if (e.key === "Escape") row.remove();
    if (e.key === "Enter" && inp.value.trim()) {
      fetch("/api/mkdir", { method: "POST", body: JSON.stringify({ parent: pkPath, name: inp.value.trim() }) })
        .then((r) => { if (r.ok) pkNavigate(pkPath, false); else r.json().then((j) => (inp.placeholder = j.error || "failed", inp.value = "")); });
    }
  };
  inp.onblur = () => row.remove();
};

// ---------- new session modal ----------
const modal = $("#new-modal"), shellSel = $("#new-shell"), cwdIn = $("#new-cwd"), nameIn = $("#new-name");
function openModal() {
  const w = currentWs ? wsById(currentWs) : null;
  modal.classList.remove("hidden");
  cwdIn.value = w ? w.path : (hostInfo.home || "");
  cwdIn.disabled = !!w;
  nameIn.value = "";
  nameIn.placeholder = w ? w.name : "(optional)";
  nameIn.focus();
}
function closeModal() { modal.classList.add("hidden"); cwdIn.disabled = false; }
$("#new-btn").onclick = openModal;
$("#empty-new").onclick = openModal;
$("#new-cancel").onclick = closeModal;
modal.onclick = (e) => e.target === modal && closeModal();
$("#new-browse").onclick = () => openPicker((p) => { cwdIn.value = p; });
$("#new-ok").onclick = () => {
  send({
    type: "create", shell: shellSel.value, cols: 120, rows: 32,
    name: nameIn.value || undefined,
    ...(currentWs ? { workspace: currentWs } : { cwd: cwdIn.value || undefined }),
  });
  closeModal();
};

// ---------- boot ----------
(async () => {
  const info = await fetch("/api/info").then((r) => r.json()).catch(() => ({}));
  hostInfo = info;
  $("#host-info").textContent = `${info.hostname || "?"} · ${info.tailscaleIp || location.hostname}`;
  for (const sh of info.shells || ["powershell"]) {
    const o = document.createElement("option");
    o.value = o.textContent = sh;
    shellSel.appendChild(o);
  }
  loadWorkspaces();
  applyToggles();
  connect();
  new ResizeObserver(() => {
    const p = panes.get(activeId);
    if (p && activeId) sendSize(activeId, p);
  }).observe(termsEl);
  // iOS Safari: soft keyboard shrinks visual viewport without firing layout resize
  if (window.visualViewport) visualViewport.addEventListener("resize", () => {
    const p = panes.get(activeId);
    if (p && activeId) requestAnimationFrame(() => sendSize(activeId, p));
  });
})();
