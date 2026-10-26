#!/usr/bin/env bash
# S-remote — Linux installer (headless: terminals + files, no remote screen).
#
#   curl -fsSL https://raw.githubusercontent.com/thsangyk-oss/sremote/main/install.sh | sudo bash
#
# Root/sudo  -> /opt/sremote, systemd system service running as $SUDO_USER
# No root    -> ~/.local/share/sremote, systemd --user service
# Env: SREMOTE_DIR, SREMOTE_USER, SREMOTE_REF (branch/tag, default main),
#      SREMOTE_PORT (default 2209).   Uninstall: ... | sudo bash -s -- --uninstall
set -euo pipefail

REPO="thsangyk-oss/sremote"
REF="${SREMOTE_REF:-main}"
PORT="${SREMOTE_PORT:-2209}"
NODE_MAJOR=22
UNIT=sremote

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "this installer is for Linux (use install.ps1 on Windows)"

if [ "$(id -u)" -eq 0 ]; then
  MODE=system
  RUN_USER="${SREMOTE_USER:-${SUDO_USER:-root}}"
  DIR="${SREMOTE_DIR:-/opt/sremote}"
  SYSTEMCTL="systemctl"
  UNIT_FILE="/etc/systemd/system/$UNIT.service"
else
  MODE=user
  RUN_USER="$(id -un)"
  DIR="${SREMOTE_DIR:-$HOME/.local/share/sremote}"
  SYSTEMCTL="systemctl --user"
  UNIT_FILE="$HOME/.config/systemd/user/$UNIT.service"
fi
PWLINE="$(getent passwd "$RUN_USER" 2>/dev/null || grep "^$RUN_USER:" /etc/passwd || true)"
RUN_HOME="$(printf '%s' "$PWLINE" | cut -d: -f6)"
RUN_SHELL="$(printf '%s' "$PWLINE" | cut -d: -f7)"; [ -x "$RUN_SHELL" ] || RUN_SHELL=/bin/bash
[ -n "$RUN_HOME" ] || die "unknown user: $RUN_USER"

# ---------- uninstall ----------
if [ "${1:-}" = "--uninstall" ]; then
  say "stopping service"
  $SYSTEMCTL disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"; $SYSTEMCTL daemon-reload 2>/dev/null || true
  pkill -f "$DIR/agent/session-host.js" 2>/dev/null || true
  say "removing $DIR"
  rm -rf "$DIR"
  say "uninstalled"
  exit 0
fi

need() { command -v "$1" >/dev/null 2>&1; }

pkg_install() {   # best effort; only as root
  [ "$(id -u)" -eq 0 ] || return 1
  if need apt-get; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif need dnf; then dnf install -y -q "$@"
  elif need yum; then yum install -y -q "$@"
  elif need pacman; then pacman -Sy --noconfirm --needed "$@"
  elif need apk; then apk add --no-cache "$@"
  elif need zypper; then zypper -n install "$@"
  else return 1; fi
}

for t in curl tar; do need "$t" || pkg_install "$t" || die "missing $t"; done
need unzip || pkg_install unzip || true   # optional: .zip extract in the file panel
need systemctl || die "systemd is required (systemctl not found)"

mkdir -p "$DIR"

# ---------- node (portable copy in $DIR/node unless a recent one exists) ----------
NODE=""
if need node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then
  NODE="$(command -v node)"
fi
if [ -z "$NODE" ] && [ -x "$DIR/node/bin/node" ]; then NODE="$DIR/node/bin/node"; fi
if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    armv7l) ARCH=armv7l ;;
    ppc64le) ARCH=ppc64le ;;
    s390x) ARCH=s390x ;;
    *) die "unsupported arch $(uname -m) — install Node >= 18 yourself and re-run" ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tarball="$(curl -fsSL "$base/SHASUMS256.txt" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$ARCH\.tar\.gz$" | head -1)"
  [ -n "$tarball" ] || die "no node build for linux-$ARCH"
  say "downloading $tarball"
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  curl -fsSL "$base/$tarball" | tar -xz -C "$DIR/node" --strip-components=1
  NODE="$DIR/node/bin/node"
fi
NPM="$(dirname "$NODE")/npm"; [ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || die "npm not found next to $NODE"
say "node $("$NODE" -v) at $NODE"

# ---------- app files (keeps data/, state.json, node_modules on upgrade) ----------
say "fetching $REPO@$REF"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$tmp" --strip-components=1
for f in server.js package.json package-lock.json README.md install.sh; do
  [ -f "$tmp/$f" ] && cp -f "$tmp/$f" "$DIR/"
done
rm -rf "$DIR/public" "$DIR/agent"
cp -r "$tmp/public" "$tmp/agent" "$DIR/"
chmod +x "$DIR/install.sh" 2>/dev/null || true

# ---------- deps (node-pty: prebuilt if available, else compiled) ----------
say "installing npm dependencies"
export PATH="$(dirname "$NODE"):$PATH"
if ! (cd "$DIR" && "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error); then
  warn "npm ci failed — installing build tools for node-pty and retrying"
  if need apt-get; then pkg_install build-essential python3 || true
  elif need apk; then pkg_install build-base python3 linux-headers || true
  elif need pacman; then pkg_install base-devel python || true
  else pkg_install gcc gcc-c++ make python3 || true; fi
  (cd "$DIR" && "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error) \
    || die "npm install failed (node-pty needs: python3, make, g++)"
fi

mkdir -p "$DIR/data"
[ "$MODE" = system ] && chown -R "$RUN_USER": "$DIR"

# ---------- systemd ----------
# KillMode=process: only server.js is stopped on restart/upgrade; the detached
# agent/session-host.js keeps the PTYs (and whatever runs in them) alive.
say "writing $UNIT_FILE"
mkdir -p "$(dirname "$UNIT_FILE")"
{
  echo "[Unit]"
  echo "Description=S-remote (web terminal over Tailscale)"
  echo "After=network-online.target tailscaled.service"
  echo "Wants=network-online.target"
  echo
  echo "[Service]"
  [ "$MODE" = system ] && echo "User=$RUN_USER"
  echo "WorkingDirectory=$DIR"
  echo "Environment=HOME=$RUN_HOME"
  echo "Environment=USER=$RUN_USER"
  echo "Environment=SHELL=$RUN_SHELL"
  echo "Environment=LANG=${LANG:-C.UTF-8}"
  echo "Environment=SREMOTE_PORT=$PORT"
  echo "Environment=PATH=$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  echo "ExecStart=$NODE $DIR/server.js"
  echo "Restart=always"
  echo "RestartSec=2"
  echo "KillMode=process"
  echo
  echo "[Install]"
  [ "$MODE" = system ] && echo "WantedBy=multi-user.target" || echo "WantedBy=default.target"
} > "$UNIT_FILE"

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable "$UNIT" >/dev/null 2>&1
$SYSTEMCTL restart "$UNIT"
if [ "$MODE" = user ]; then
  loginctl enable-linger "$RUN_USER" 2>/dev/null \
    || warn "run 'sudo loginctl enable-linger $RUN_USER' so it starts at boot without a login"
fi

# ---------- tailscale ----------
TS_IP=""
if need tailscale; then TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"; fi
if [ -z "$TS_IP" ]; then
  warn "Tailscale not found/connected — S-remote only accepts localhost + tailnet clients."
  warn "  install: curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
fi

sleep 1
if curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
  say "S-remote is running (user: $RUN_USER, dir: $DIR)"
else
  warn "service did not answer yet — check: $SYSTEMCTL status $UNIT  /  journalctl $([ "$MODE" = user ] && echo --user) -u $UNIT"
fi
echo "    local:     http://localhost:$PORT"
[ -n "$TS_IP" ] && echo "    tailscale: http://$TS_IP:$PORT"
echo "    update:    re-run this installer · uninstall: add  -s -- --uninstall"
