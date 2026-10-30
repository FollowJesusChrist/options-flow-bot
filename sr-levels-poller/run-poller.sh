#!/usr/bin/env bash
# run-poller.sh — start the #support-resistance `levels` poller with plain nohup.
#
# VM rule (AGENTS.md): run this from an exec shell. systemd / PM2 / setsid-detached
# processes can't reach the network here; a nohup child of an exec shell can.
#
# Discord token: DISCORD_BOT_TOKEN from the environment, or (so the watchdog can
# relaunch unattended) from this poller's OWN token file, mode 600:
#   $SR_POLLER_TOKEN_FILE (default: <this dir>/.discord-token)
# It is never read from another bot's folder and never printed.
# Tradier: the poller fetches its own read-only surrogate from the connector vault.
#
#   ./run-poller.sh          start (no-op if already running)
#   ./run-poller.sh stop     stop
#   ./run-poller.sh status   running? + heartbeat
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
export TRADING_DATA_DIR="${TRADING_DATA_DIR:-$HOME/workspace/trading-data}"
STATE="$TRADING_DATA_DIR/state"; LOGS="$TRADING_DATA_DIR/logs"
PIDFILE="$STATE/sr-levels-poller.pid"
OUTLOG="$LOGS/sr-levels-poller.out.log"
HEARTBEAT="$LOGS/sr-levels-poller.heartbeat"
TOKEN_FILE="${SR_POLLER_TOKEN_FILE:-$HERE/.discord-token}"
mkdir -p "$STATE" "$LOGS"

running_pid() {
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)" || return 1
  [[ -n "$pid" ]] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "sr-levels-poller/poller.js" && echo "$pid"
}

case "${1:-start}" in
  status)
    if pid="$(running_pid)"; then echo "running pid $pid"; else echo "not running"; fi
    echo "heartbeat: $(cat "$HEARTBEAT" 2>/dev/null || echo none)"
    exit 0 ;;
  stop)
    if pid="$(running_pid)"; then kill "$pid" && echo "stopped pid $pid"; else echo "not running"; fi
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status]"; exit 2 ;;
esac

if pid="$(running_pid)"; then echo "already running (pid $pid)"; exit 0; fi

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  if [[ -f "$TOKEN_FILE" ]]; then
    perm="$(stat -c %a "$TOKEN_FILE")"
    if [[ "$perm" != "600" && "$perm" != "400" ]]; then echo "refusing: $TOKEN_FILE must be mode 600 (is $perm)"; exit 2; fi
    DISCORD_BOT_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  fi
fi
if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  echo "no Discord token: export DISCORD_BOT_TOKEN or create $TOKEN_FILE (mode 600)"; exit 2
fi
export DISCORD_BOT_TOKEN

nohup node "$HERE/poller.js" >> "$OUTLOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 6
if pid="$(running_pid)"; then
  echo "started pid $pid; log $OUTLOG"
  tail -n 3 "$OUTLOG"
else
  echo "FAILED to start; last log lines:"; tail -n 10 "$OUTLOG"; exit 1
fi
