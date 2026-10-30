#!/usr/bin/env bash
# run-sr.sh — support/resistance bot entry point (paper, read-only Tradier).
#
#   ./run-sr.sh record    save SPY/QQQ bars to the local store
#   ./run-sr.sh replay    offline level engine + grading vs random control
#   ./run-sr.sh shadow    one live shadow pass: record bars, levels → store only
#
# Set TRADIER_TOKEN in your environment first (see .env.example).
# No orders, no order code. No Discord post unless the posting gates in
# src/sr/post.js are opened explicitly (they are OFF by default).
# This script creates no cron and no loop — one pass per invocation.
set -euo pipefail
cd "$(dirname "$0")"

: "${TRADIER_TOKEN:?Set TRADIER_TOKEN first — see .env.example}"
export TRADIER_BASE="${TRADIER_BASE:-https://api.tradier.com/v1}"

case "${1:-}" in
  record) shift; exec node src/sr/recorder.js "$@" ;;
  replay) shift; exec node src/sr/replay.js "$@" ;;
  shadow) exec node src/sr/shadow.js ;;
  *) echo "usage: $0 record|replay|shadow"; exit 2 ;;
esac
