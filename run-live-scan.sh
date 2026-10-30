#!/usr/bin/env bash
# run-live-scan.sh — one live scan pass of the options flow bot.
#
# Set TRADIER_TOKEN and TRADIER_BASE in your environment first
# (see .env.example). Paper mode is structural — no order code exists,
# the bot only finds signals and posts alerts.
set -euo pipefail
cd "$(dirname "$0")"

: "${TRADIER_TOKEN:?Set TRADIER_TOKEN first — see .env.example}"
export TRADIER_BASE="${TRADIER_BASE:-https://api.tradier.com/v1}"
# SNIPER_POST_ONLY=1 posts only top-tier signals; 0 posts all qualified
# signals while the per-contract history is still building.
export SNIPER_POST_ONLY="${SNIPER_POST_ONLY:-0}"
exec node src/runner.js
