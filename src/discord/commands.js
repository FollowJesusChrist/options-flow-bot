// commands.js — slash command definitions (JSON for Discord registration).
// /analyze TICKER  -> on-demand full signal workup on any ticker
// /watchlist       -> show / add / remove tickers
// /kill            -> emergency halt (stops scanning, keeps bot online)
// /stats           -> paper-trade accuracy stats

export const COMMANDS = [
  {
    name: "analyze",
    description: "Run a full signal workup on any ticker right now",
    options: [
      {
        name: "ticker",
        description: "Stock symbol, e.g. AAPL",
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: "watchlist",
    description: "Manage the scan watchlist",
    options: [
      {
        name: "action",
        description: "What to do",
        type: 3,
        required: true,
        choices: [
          { name: "show", value: "show" },
          { name: "add", value: "add" },
          { name: "remove", value: "remove" },
        ],
      },
      {
        name: "ticker",
        description: "Stock symbol (for add/remove)",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "kill",
    description: "Emergency halt — stop all scanning immediately",
  },
  {
    name: "stats",
    description: "Paper-trade accuracy stats",
  },
];
