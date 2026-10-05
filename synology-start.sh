#!/bin/sh
# ---------------------------------------------------------------------------
# Startup script for pm2-gui on Synology DSM
#
# The dashboard is a standalone Node/Express process on $PORT — not a PM2 app.
# If Task Scheduler runs this as root, only root (or sudo) can stop it.
# Prefer Task Scheduler user = your DSM user (e.g. diko), not root.
#
# Usage (messages go to the terminal and pm2-gui.log):
#   sh synology-start.sh           # start if not already listening
#   sh synology-start.sh stop      # stop dashboard only
#   sh synology-start.sh restart   # stop then start (after code updates)
#   sh synology-start.sh status    # show listeners / matching pids
#
# Task Scheduler boot command:
#   sh /path/to/pm2-gui/synology-start.sh
# ---------------------------------------------------------------------------

APP_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ACTION="${1:-start}"

if [ -f "$APP_DIR/.pm2-gui-boot.env" ]; then
  # shellcheck disable=SC1091
  . "$APP_DIR/.pm2-gui-boot.env"
fi

if [ -n "${USER_HOME:-}" ]; then
  HOME="$USER_HOME"
elif [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  _user=$(id -un 2>/dev/null || true)
  if [ -n "$_user" ] && [ -d "/var/services/homes/$_user" ]; then
    HOME="/var/services/homes/$_user"
  elif [ -n "$_user" ]; then
    HOME=$(getent passwd "$_user" 2>/dev/null | cut -d: -f6)
  fi
  unset _user
fi
export HOME

export PATH="${HOME:+$HOME/.npm-global/bin:}/usr/local/bin:/var/packages/Node.js_v20/target/usr/local/bin:/var/packages/Node.js_v18/target/usr/local/bin:/bin:/usr/bin:/sbin:/usr/sbin:${PATH:-}"

LOG="$APP_DIR/pm2-gui.log"
PORT="${PORT:-8088}"

# IMPORTANT: write to stderr so `_pids=$(fn)` never captures log lines as PIDs.
say () {
  echo "$*" >&2
  echo "$*" >> "$LOG"
}

is_numeric_pid () {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ] 2>/dev/null
}

pid_cmdline () {
  _pid=$1
  is_numeric_pid "$_pid" || return 0
  if [ -r "/proc/$_pid/cmdline" ] && [ -s "/proc/$_pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$_pid/cmdline"
    echo
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo -n tr '\0' ' ' < "/proc/$_pid/cmdline" 2>/dev/null && echo
  fi
}

listen_inodes_for_port () {
  _hex=$(printf '%04X' "$PORT")
  # shellcheck disable=SC2002
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v h=":$_hex" '
    NR == 1 { next }
    {
      if ($4 == "0A" && $2 ~ h"$") {
        split($10, a, ":")
        if (a[1] != "0" && a[1] != "") print a[1]
      }
    }
  '
}

pids_holding_inode () {
  _inode=$1
  [ -n "$_inode" ] || return 0
  for _fd in /proc/[0-9]*/fd/*; do
    _link=$(readlink "$_fd" 2>/dev/null) || continue
    if [ "$_link" = "socket:[$_inode]" ]; then
      echo "$_fd" | cut -d/ -f3
    fi
  done
}

# Root-owned listeners: /proc/PID/fd is not readable without elevation.
# stdout = PIDs only (no log text).
find_pids_via_sudo () {
  command -v sudo >/dev/null 2>&1 || return 0
  sudo sh -c '
    PORT="$1"
    hex=$(printf "%04X" "$PORT")
    inodes=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v h=":$hex" "
      NR==1 { next }
      \$4==\"0A\" && \$2 ~ h\"\$\" {
        split(\$10,a,\":\"); if (a[1]!=\"0\" && a[1]!=\"\") print a[1]
      }")
    for inode in $inodes; do
      for fd in /proc/[0-9]*/fd/*; do
        link=$(readlink "$fd" 2>/dev/null) || continue
        if [ "$link" = "socket:[$inode]" ]; then
          echo "$fd" | cut -d/ -f3
        fi
      done
    done
    for proc in /proc/[0-9]*; do
      pid=${proc#/proc/}
      [ -s "$proc/cmdline" ] || continue
      cmd=$(tr "\0" " " < "$proc/cmdline" 2>/dev/null)
      case "$cmd" in
        *pm2-gui.js*|*"/pm2-gui "*|*"/pm2-gui") echo "$pid" ;;
      esac
    done
  ' sh "$PORT" 2>/dev/null
}

pids_on_port () {
  for _ino in $(listen_inodes_for_port); do
    pids_holding_inode "$_ino"
  done
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null
  fi
}

dashboard_pids () {
  for _proc in /proc/[0-9]*; do
    _pid=${_proc#/proc/}
    is_numeric_pid "$_pid" || continue
    [ -s "$_proc/cmdline" ] || continue
    _cmd=$(tr '\0' ' ' < "$_proc/cmdline" 2>/dev/null)
    case "$_cmd" in
      *pm2-gui.js*|*'/pm2-gui '*|*'/pm2-gui')
        echo "$_pid"
        ;;
    esac
  done
}

# Filter stdin/args down to unique numeric PIDs that still exist.
unique_real_pids () {
  echo "$*" | tr ' \n\t' '\n' | while read -r _p; do
    is_numeric_pid "$_p" || continue
    [ -d "/proc/$_p" ] || continue
    echo "$_p"
  done | sort -u
}

port_in_use () {
  _inos=$(listen_inodes_for_port)
  if [ -n "$_inos" ]; then
    return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -E "[:.]${PORT}[ ]" >/dev/null 2>&1
    return $?
  fi
  return 1
}

kill_pid () {
  _pid=$1
  _sig=${2:-TERM}
  is_numeric_pid "$_pid" || return 1
  if kill -s "$_sig" "$_pid" 2>/dev/null; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo kill -s "$_sig" "$_pid" 2>/dev/null && return 0
  fi
  return 1
}

# stdout = numeric PIDs only
collect_dashboard_pids () {
  _found=$(unique_real_pids "$(dashboard_pids) $(pids_on_port)")
  if [ -z "$_found" ] && port_in_use; then
    say "info: listener not owned by $(id -un) — trying sudo to find pid"
    _found=$(unique_real_pids "$(find_pids_via_sudo)")
  fi
  # Final filter so callers never see non-numeric junk
  unique_real_pids "$_found"
}

show_status () {
  say "status: APP_DIR=$APP_DIR PORT=$PORT user=$(id -un)"
  if port_in_use; then
    say "status: port $PORT is IN USE"
  else
    say "status: port $PORT is free"
  fi

  _inos=$(listen_inodes_for_port)
  [ -n "$_inos" ] && say "status: listen inodes: $_inos"

  _pids=$(collect_dashboard_pids)
  if [ -n "$_pids" ]; then
    say "status: dashboard pids: $_pids"
    for _p in $_pids; do
      is_numeric_pid "$_p" || continue
      say "status:   pid $_p: $(pid_cmdline "$_p")"
    done
  else
    say "status: no dashboard pid found"
    if port_in_use; then
      say "status: port held by another user — run:"
      say "status:   sudo fuser -k ${PORT}/tcp"
      say "status:   sudo netstat -ltnp | grep $PORT"
      say "status: Set Task Scheduler → User to $(id -un) (not root)."
    fi
  fi

  if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe pm2-gui >/dev/null 2>&1; then
      say "status: WARN 'pm2-gui' is listed under PM2 — delete it"
    else
      say "status: 'pm2-gui' is not under PM2 (good)"
    fi
  fi
}

stop_dashboard () {
  say "stop: stopping dashboard on port $PORT (PM2 apps are left alone)"

  if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe pm2-gui >/dev/null 2>&1; then
      say "stop: deleting PM2 entry 'pm2-gui'"
      pm2 delete pm2-gui >/dev/null 2>&1 || true
      pm2 save >/dev/null 2>&1 || true
    fi
  fi

  _pids=$(collect_dashboard_pids)
  if [ -z "$_pids" ]; then
    if ! port_in_use; then
      say "stop: nothing listening on $PORT"
      return 0
    fi
    say "stop: could not resolve pid — trying sudo fuser"
    if command -v sudo >/dev/null 2>&1; then
      sudo fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
      sleep 1
    fi
    if port_in_use; then
      say "stop: port $PORT still in use — run:"
      say "stop:   sudo fuser -k ${PORT}/tcp"
      say "stop:   sudo netstat -ltnp | grep $PORT"
      return 1
    fi
    say "stop: port $PORT is free"
    return 0
  fi

  for _pid in $_pids; do
    is_numeric_pid "$_pid" || continue
    say "stop: kill $_pid ($(pid_cmdline "$_pid"))"
    kill_pid "$_pid" TERM || true
  done
  sleep 1
  for _pid in $_pids; do
    is_numeric_pid "$_pid" || continue
    if [ -d "/proc/$_pid" ]; then
      say "stop: kill -9 $_pid"
      kill_pid "$_pid" KILL || true
    fi
  done
  sleep 1

  if port_in_use; then
    say "stop: WARN port $PORT still in use — trying sudo fuser"
    if command -v sudo >/dev/null 2>&1; then
      sudo fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi

  if port_in_use; then
    say "stop: WARN port $PORT still in use"
    show_status
    return 1
  fi
  say "stop: port $PORT is free"
  return 0
}

start_dashboard () {
  say "start: APP_DIR=$APP_DIR HOME=$HOME user=$(id -un)"

  cd "$APP_DIR" || { say "ERROR: cannot cd to $APP_DIR"; exit 1; }

  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then
    say "ERROR: node not found on PATH"
    exit 1
  fi
  say "start: using $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"

  if port_in_use; then
    say "start: SKIP — port $PORT already in use"
    show_status
    exit 0
  fi

  if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe pm2-gui >/dev/null 2>&1; then
      say "start: removing 'pm2-gui' from PM2"
      pm2 delete pm2-gui >/dev/null 2>&1 || true
      pm2 save >/dev/null 2>&1 || true
    fi
  fi

  say "start: launching node pm2-gui.js start"
  setsid "$NODE_BIN" pm2-gui.js start >> "$LOG" 2>&1 &
  _newpid=$!
  say "start: launched pid $_newpid at $(date 2>/dev/null)"
  sleep 1
  if is_numeric_pid "$_newpid" && [ -d "/proc/$_newpid" ]; then
    say "start: process $_newpid is alive: $(pid_cmdline "$_newpid")"
  else
    say "start: WARN process exited — check $LOG"
  fi
  if port_in_use; then
    say "start: port $PORT is listening"
  else
    say "start: WARN port $PORT not listening yet — check $LOG"
  fi
}

echo "==============================================================" >> "$LOG"
say "synology-start: action=$ACTION $(date 2>/dev/null)"

case "$ACTION" in
  stop)
    stop_dashboard
    ;;
  restart)
    stop_dashboard || true
    sleep 1
    start_dashboard
    ;;
  status)
    show_status
    ;;
  start|'')
    start_dashboard
    ;;
  *)
    say "Usage: sh $0 [start|stop|restart|status]"
    exit 1
    ;;
esac
