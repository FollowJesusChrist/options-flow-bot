#!/usr/bin/env bash
# run-dryrun.sh — /chart dry run with live Tradier data.
# Fake interactions, nothing goes to Discord.
# Set TRADIER_TOKEN in your environment first (see ../../.env.example).
#   ./run-dryrun.sh                 fixed case list
#   ./run-dryrun.sh NVDA:15DTE TSLA  your own tickers
set -euo pipefail
cd "$(dirname "$0")"
: "${TRADIER_TOKEN:?Set TRADIER_TOKEN first — see ../../.env.example}"
exec node dryrun.js "$@"
