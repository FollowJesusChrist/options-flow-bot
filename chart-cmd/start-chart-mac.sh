#!/bin/bash
# start-chart-mac.sh — the one script that starts /chart on the Mac.
# Checks Node, installs packages if needed, checks the two tokens, runs the
# offline tests, then starts the listener and keeps the Mac awake while it runs.
# Tokens come from the environment only and are never printed.
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo; echo "STOP: $*"; exit 1; }

echo "1/5 Checking Node..."
command -v node >/dev/null 2>&1 || fail "Node is not installed. Install the LTS version from https://nodejs.org, then run this script again."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || fail "Node $(node -v) is too old. Install the LTS version from https://nodejs.org, then run this script again."
echo "    Node $(node -v) OK"

echo "2/5 Checking packages..."
if ! node -e 'Promise.all([import("discord.js"), import("@resvg/resvg-js")]).catch(() => process.exit(1))' >/dev/null 2>&1; then
  echo "    Installing (one time, about a minute)..."
  command -v npm >/dev/null 2>&1 || fail "npm is missing. Reinstall Node from https://nodejs.org."
  npm install --no-audit --no-fund || fail "npm install failed. Check the Mac is online and run this script again."
fi
echo "    Packages OK"

echo "3/5 Checking tokens..."
missing=""
[ -n "${CHART_DISCORD_BOT_TOKEN:-}" ] || missing="$missing CHART_DISCORD_BOT_TOKEN"
[ -n "${TRADIER_TOKEN:-}" ] || missing="$missing TRADIER_TOKEN"
if [ -n "$missing" ]; then
  fail "Token not set:$missing
In this same Terminal window, paste these two lines (each one asks for a token; typing stays hidden):
  read -s \"CHART_DISCORD_BOT_TOKEN?Discord bot token: \"; echo; export CHART_DISCORD_BOT_TOKEN
  read -s \"TRADIER_TOKEN?Tradier token: \"; echo; export TRADIER_TOKEN
Then run ./start-chart-mac.sh again."
fi
echo "    Both tokens set"

echo "4/5 Running offline tests..."
node test.js || fail "Offline tests failed (output above). Nothing was started."

echo "5/5 Starting /chart. Leave this window open; Ctrl-C stops it."
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -is node listener.js
else
  exec node listener.js
fi
