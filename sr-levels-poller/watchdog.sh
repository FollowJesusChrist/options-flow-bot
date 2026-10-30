#!/usr/bin/env bash
# watchdog.sh — check the `levels` poller and relaunch it via the nohup path if dead.
# Meant for an agent cron (~every 30 min) so the relaunch happens from an exec shell
# (the only context whose child processes can reach the network on this VM).
#
# Healthy = process alive AND heartbeat written within the last 5 minutes
# (the loop writes it after every successful 30 s poll).
#   alive + fresh   → OK, nothing done
#   alive + stale   → hung: kill, relaunch
#   dead            → relaunch
# Prints one status line (OK / RELAUNCHED / FAILED). Exit 0 unless the relaunch failed.
# Never prints the token. Touches nothing outside this poller.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export TRADING_DATA_DIR="${TRADING_DATA_DIR:-$HOME/workspace/trading-data}"
LOGS="$TRADING_DATA_DIR/logs"
HEARTBEAT="$LOGS/sr-levels-poller.heartbeat"
WDLOG="$LOGS/sr-levels-poller.watchdog.log"
MAX_AGE=300
now="$(date +%s)"
stamp="$(date -u +%FT%TZ)"

status="$("$HERE/run-poller.sh" status)"
age=999999
[[ -f "$HEARTBEAT" ]] && age=$(( now - $(stat -c %Y "$HEARTBEAT") ))

if grep -q "^running" <<<"$status"; then
  if (( age <= MAX_AGE )); then
    echo "OK $stamp ${status%%$'\n'*}, heartbeat ${age}s ago" | tee -a "$WDLOG"; exit 0
  fi
  "$HERE/run-poller.sh" stop >/dev/null
  sleep 2
  why="hung (heartbeat ${age}s old)"
else
  why="dead (heartbeat ${age}s old)"
fi

out="$("$HERE/run-poller.sh" start 2>&1)"; rc=$?
if (( rc == 0 )) && grep -q "^started\|^already running" <<<"$out"; then
  echo "RELAUNCHED $stamp poller was $why → ${out%%$'\n'*}" | tee -a "$WDLOG"; exit 0
fi
echo "FAILED $stamp poller was $why; relaunch failed: $(tr '\n' ' ' <<<"$out" | cut -c1-300)" | tee -a "$WDLOG"
exit 1
