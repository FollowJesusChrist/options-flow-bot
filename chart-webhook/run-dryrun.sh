#!/usr/bin/env bash
# run-dryrun.sh — chart-webhook dry run / tests with live Tradier data.
# Signed fake interactions, stubbed Discord webhook — nothing goes to Discord.
# Set TRADIER_TOKEN in your environment first (see ../../.env.example).
#   ./run-dryrun.sh                  dry run, fixed case list
#   ./run-dryrun.sh NVDA:15DTE SOFI  dry run, your own tickers
#   ./run-dryrun.sh --frames         interval + lookback cases (a-f)
#   ./run-dryrun.sh SOFI:interval=15m,lookback=1month
#   ./run-dryrun.sh --test           test.mjs with live Tradier
set -euo pipefail
cd "$(dirname "$0")"
: "${TRADIER_TOKEN:?Set TRADIER_TOKEN first — see ../../.env.example}"
if [ "${1:-}" = "--test" ]; then exec node test.mjs; fi
exec node dryrun.mjs "$@"
