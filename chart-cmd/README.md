# /chart

Type `/chart SPY` in #support-resistance on the lab server. The bot answers with a chart
and a short card: price, nearest support below, nearest resistance above. You can add a
timeframe like `dte: 0DTE` or `dte: 15DTE`. Paper mode only, not financial advice.

**What you need:** your Mac, Node (LTS from nodejs.org), this whole `options-flow-bot`
folder, the Discord bot token, and the Tradier token.

**Start it:**
1. Copy the `options-flow-bot` folder to the Mac (first time only).
2. Open Terminal and go into the folder: `cd options-flow-bot/chart-cmd`
3. Set the two tokens (each line asks for one; typing stays hidden):
   `read -s "CHART_DISCORD_BOT_TOKEN?Discord bot token: "; echo; export CHART_DISCORD_BOT_TOKEN`
   `read -s "TRADIER_TOKEN?Tradier token: "; echo; export TRADIER_TOKEN`
4. Run `./start-chart-mac.sh`. When it says "/chart is ready", leave the window open.

**Test it:** type `/chart SPY` in #support-resistance. A chart shows up in a few seconds.

**If Discord says "The application did not respond":** the listener is not running. The
listener is the program that stays on and answers Discord when someone types /chart.
Run `./start-chart-mac.sh` again and keep the Mac awake, online, and the window open.

Other limits: one /chart per person per minute, and it only answers in #support-resistance.

Fallback: if the Mac can't stay on, the same folder runs on a small Linux VPS with `node listener.js`.
