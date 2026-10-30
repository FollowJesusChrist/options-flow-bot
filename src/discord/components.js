// components.js — Discord message components: buttons + contract picker.
// custom_id scheme: "<action>:<signalRefId>" — parsed by the interaction router.
// Actions: track | paper | dismiss | contract

export function signalButtons(signalRefId) {
  return [
    {
      type: 1, // ACTION_ROW
      components: [
        { type: 2, style: 1, label: "Track", custom_id: `track:${signalRefId}` }, // PRIMARY
        { type: 2, style: 3, label: "Paper Trade", custom_id: `paper:${signalRefId}` }, // SUCCESS
        { type: 2, style: 2, label: "Dismiss", custom_id: `dismiss:${signalRefId}` }, // SECONDARY
      ],
    },
  ];
}

// contracts: [{ label, strike, delta, mid, value }] — value must be unique per option.
export function contractPicker(signalRefId, contracts) {
  if (!contracts.length) return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 3, // STRING_SELECT
          custom_id: `contract:${signalRefId}`,
          placeholder: "Pick a contract",
          min_values: 1,
          max_values: 1,
          options: contracts.map((c, i) => ({
            label: c.label.slice(0, 100),
            value: `${signalRefId}:${i}`.slice(0, 100),
            description: `Δ ${c.delta?.toFixed(2) ?? "n/a"} · mid $${c.mid?.toFixed(2) ?? "n/a"}`.slice(0, 100),
          })),
        },
      ],
    },
  ];
}

// Parse a button/select custom_id back into { action, signalRefId, extra }.
export function parseCustomId(customId) {
  const [action, ...rest] = String(customId).split(":");
  const signalRefId = rest.slice(0, -1).join(":") || rest[0] || "";
  const extra = rest.length > 1 ? rest[rest.length - 1] : null;
  return { action, signalRefId, extra };
}
